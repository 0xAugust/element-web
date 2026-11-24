/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, EventTimeline, MatrixEvent, Room, RoomEvent, TimelineWindow } from "matrix-js-sdk/src/matrix";

import { paginateDesktopHistory, startDesktopHistory } from "./DesktopHistory";

const roomId = "!room:example.org";
const userId = "@user:example.org";

function openRoom(scope: string) {
    const client = createClient({ baseUrl: "https://example.org", userId, timelineSupport: true });
    const room = new Room(roomId, client, userId);
    startDesktopHistory(client, scope);
    return { client, room, timelineSet: room.getUnfilteredTimelineSet() };
}

function message(eventId: string, timestamp: number): MatrixEvent {
    return new MatrixEvent({
        event_id: eventId,
        room_id: roomId,
        sender: userId,
        origin_server_ts: timestamp,
        type: "m.room.message",
        content: { msgtype: "m.text", body: eventId },
    });
}

describe("DesktopHistory", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("restores archived events into the room after recreating the client", async () => {
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.stubGlobal("IDBKeyRange", IDBKeyRange);
        const first = openRoom("restart");
        const timeline = first.timelineSet.getLiveTimeline();
        for (const event of [
            message("$old-a", 1),
            message("$old-b", 1),
            message("$redacted", 1),
            new MatrixEvent({
                event_id: "$redaction",
                room_id: roomId,
                sender: userId,
                origin_server_ts: 2,
                type: "m.room.redaction",
                redacts: "$redacted",
                content: {},
            }),
        ]) {
            first.client.emit(RoomEvent.Timeline, event, first.room, false, false, { timeline, liveEvent: true });
        }

        const next = openRoom("restart");
        next.timelineSet.addEventToTimeline(message("$recent", 2), next.timelineSet.getLiveTimeline(), {
            toStartOfTimeline: false,
            fromCache: false,
            addToState: false,
        });
        const window = new TimelineWindow(next.client, next.timelineSet);
        await window.load(undefined, 1);

        expect(await paginateDesktopHistory(next.client, window, 1)).toBe(true);
        expect(await paginateDesktopHistory(next.client, window, 1)).toBe(true);
        expect(await paginateDesktopHistory(next.client, window, 1)).toBe(false);
        expect(window.getEvents().map((event) => event.getId())).toEqual(["$old-a", "$old-b", "$recent"]);
        expect(next.timelineSet.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS)).toBeNull();
    });
});
