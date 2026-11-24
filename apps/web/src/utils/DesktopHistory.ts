/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    EventTimeline,
    RoomEvent,
    type EventTimelineSet,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    type TimelineWindow,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

const histories = new WeakMap<MatrixClient, Promise<IDBDatabase>>();
const eventsStore = "events";
const orderIndex = "roomTimestamp";

/** Archive server events independently of the desktop sync cache. */
export function startDesktopHistory(client: MatrixClient, scope: string): void {
    const database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(`element-desktop-history:${scope}`, 1);
        request.onupgradeneeded = () => {
            const store = request.result.createObjectStore(eventsStore, { keyPath: ["room_id", "event_id"] });
            store.createIndex(orderIndex, ["room_id", "origin_server_ts", "event_id"]);
            request.result.createObjectStore("redactions");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    void database.catch((error) => logger.warn("Could not open desktop history", error));
    histories.set(client, database);
    const archiveEvent = (event: MatrixEvent, room: Room): void => {
        const id = event.getId();
        if (!id || event.status) return;
        const raw = { ...event.event, room_id: room.roomId };
        const target = event.isRedaction() ? event.getAssociatedId() : event.isRedacted() ? id : undefined;
        const saveEvent = !event.isRedaction() && !event.isRedacted() && !event.isState();
        if (!target && !saveEvent) return;

        void database
            .then((db) => {
                const transaction = db.transaction([eventsStore, "redactions"], "readwrite");
                transaction.onerror = () => logger.warn("Could not write desktop history", transaction.error);
                const store = transaction.objectStore(eventsStore);
                const redactions = transaction.objectStore("redactions");
                if (target) {
                    const key = [room.roomId, target];
                    redactions.put(true, key);
                    store.delete(key);
                }
                if (!saveEvent) return;
                const key = [room.roomId, id];
                const check = redactions.get(key);
                check.onsuccess = () => {
                    // Insert only once, keeping the original wire event for encrypted rooms.
                    if (check.result) return;
                    const existing = store.getKey(key);
                    existing.onsuccess = () => {
                        if (existing.result === undefined) store.add(raw);
                    };
                };
            })
            .catch((error) => logger.warn("Desktop history unavailable", error));
    };
    client.on(RoomEvent.Timeline, (event, room, _toStart, removed, data) => {
        if (room && !removed && data?.timeline.getTimelineSet() === room.getUnfilteredTimelineSet()) {
            archiveEvent(event, room);
        }
    });
    client.on(RoomEvent.LocalEchoUpdated, (event, room) => archiveEvent(event, room));
}

/** Whether this client's main room timeline can fall back to local history. */
export function hasDesktopHistory(client: MatrixClient, set: EventTimelineSet): boolean {
    return histories.has(client) && set === set.room?.getUnfilteredTimelineSet();
}

/** Extend the oldest timeline segment with locally archived events. */
export async function paginateDesktopHistory(
    client: MatrixClient,
    window: TimelineWindow,
    limit: number,
): Promise<boolean> {
    const backwards = EventTimeline.BACKWARDS;
    const timeline = window.getTimelineIndex(backwards)?.timeline;
    const set = timeline?.getTimelineSet();
    const room = set?.room;
    const database = histories.get(client);
    if (!database || !timeline || !set || !room || set !== room.getUnfilteredTimelineSet()) return false;
    if (timeline.getPaginationToken(backwards) != null || timeline.getNeighbouringTimeline(backwards)) return false;
    const first = timeline.getEvents()[0];
    const firstId = first?.getId();
    if (!first || !firstId) return false;

    try {
        const db = await database;
        const mapper = client.getEventMapper();
        const events = await new Promise<ReturnType<typeof mapper>[]>((resolve, reject) => {
            const results: ReturnType<typeof mapper>[] = [];
            const transaction = db.transaction(eventsStore);
            const range = IDBKeyRange.bound([room.roomId], [room.roomId, first.getTs(), firstId], false, true);
            const request = transaction.objectStore(eventsStore).index(orderIndex).openCursor(range, "prev");
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || results.length === limit) {
                    resolve(results);
                    return;
                }
                if (!set.eventIdToTimeline(cursor.value.event_id)) results.push(mapper(cursor.value));
                cursor.continue();
            };
        });
        if (!events.length || window.getTimelineIndex(backwards)?.timeline !== timeline) return false;
        if (timeline.getEvents()[0] !== first || timeline.getPaginationToken(backwards) != null) return false;
        for (const event of events) {
            set.addEventToTimeline(event, timeline, { toStartOfTimeline: true, fromCache: true, addToState: false });
        }
        return window.extend(backwards, limit);
    } catch (error) {
        logger.warn("Could not read desktop history", error);
        return false;
    }
}
