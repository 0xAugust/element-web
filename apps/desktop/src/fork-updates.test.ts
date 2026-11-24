/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";

const { showNotification, showMessageBox, settings } = vi.hoisted(() => ({
    showNotification: vi.fn(),
    showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
    settings: new Map(),
}));

vi.mock("electron", () => ({
    app: { name: "Element", getVersion: () => "1.12.35" },
    dialog: { showMessageBox },
    Notification: class {
        public static isSupported = (): boolean => true;
        public on = vi.fn();
        public show = showNotification;
    },
    shell: { openExternal: vi.fn() },
}));
vi.mock("./config.js", () => ({
    getConfig: () => ({
        desktop_update_page_url: "https://github.com/0xAugust/element-web/releases",
        desktop_build_number: "1.1",
    }),
}));
vi.mock("./language-helper.js", () => ({ _t: (key: string) => key }));
vi.mock("./store.js", () => ({ default: { instance: settings } }));

describe("fork update checks", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        vi.clearAllMocks();
        settings.clear();
    });

    it("alerts once per release and failure and clears the failure after a published build", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("mainWindow", {});
        let published = "2026-11-24T08:00:00Z";
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) =>
                Response.json(
                    url.includes("/releases/")
                        ? {
                              tag_name: "desktop-arm64-v1.12.36",
                              published_at: published,
                              assets: [{ name: "element-desktop-build-1.12.36-2.1.json" }],
                          }
                        : { workflow_runs: [{ id: 45, updated_at: "2026-11-24T09:00:00Z" }] },
                ),
            ),
        );

        const { getForkBuildFailed } = await import("./fork-updates.js");
        expect(await getForkBuildFailed()).toBe(true);
        vi.advanceTimersByTime(60_000);
        expect(await getForkBuildFailed()).toBe(true);
        expect(showNotification).toHaveBeenCalledTimes(1);
        expect(showMessageBox).toHaveBeenCalledTimes(1);

        published = "2026-11-24T10:00:00Z";
        vi.advanceTimersByTime(60_000);
        expect(await getForkBuildFailed()).toBe(false);
    });

    it("does not prompt to install an older version or the current build", async () => {
        const { isNewerForkBuild } = await import("./fork-updates.js");
        const installed = { version: "1.12.35", run: 2, attempt: 1 };
        expect(isNewerForkBuild(installed, installed)).toBe(false);
        expect(isNewerForkBuild(installed, { version: "1.12.34", run: 3, attempt: 1 })).toBe(false);
        expect(isNewerForkBuild(installed, { ...installed, attempt: 2 })).toBe(true);
    });
});
