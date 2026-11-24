/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { app, Notification, shell } from "electron";

import { getConfig } from "./config.js";
import { _t } from "./language-helper.js";
import Store from "./store.js";

interface ForkRelease {
    tag_name: string;
    published_at: string;
    assets: { name: string }[];
}

interface ForkBuild {
    id: number;
    updated_at: string;
}

interface ForkBuildVersion {
    version: string;
    run: number;
    attempt: number;
}

let lastChecked = 0;
let buildFailed = false;
let pendingCheck: Promise<boolean> | undefined;

/** Compare the installed app and published app, including rebuilds of the same version. */
export function isNewerForkBuild(installed: ForkBuildVersion, published: ForkBuildVersion): boolean {
    const versionPattern = /^\d+\.\d+\.\d+$/;
    if (!versionPattern.test(installed.version) || !versionPattern.test(published.version)) return false;
    const current = installed.version.split(".").map(Number).concat(installed.run, installed.attempt);
    const next = published.version.split(".").map(Number).concat(published.run, published.attempt);
    const difference = next.findIndex((part, i) => part !== current[i]);
    return difference !== -1 && next[difference] > current[difference];
}

async function readGitHub<T>(url: string, allowMissing = false): Promise<T | undefined> {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub update check returned HTTP ${response.status}`);
    return (await response.json()) as T;
}

async function check(repo: string, installed: ForkBuildVersion): Promise<boolean> {
    const baseUrl = `https://api.github.com/repos/${repo}`;
    const [release, failures] = await Promise.all([
        readGitHub<ForkRelease>(`${baseUrl}/releases/latest`, true),
        readGitHub<{ workflow_runs: ForkBuild[] }>(
            `${baseUrl}/actions/workflows/build_desktop_history_macos.yaml/runs?branch=develop&status=failure&per_page=1`,
        ),
    ]);
    const failure = failures?.workflow_runs[0];
    buildFailed = !!failure && (!release || Date.parse(failure.updated_at) > Date.parse(release.published_at));
    const store = Store.instance;
    if (!store) return buildFailed;

    if (buildFailed && failure && failure.id !== store.get("lastNotifiedForkFailure") && Notification.isSupported()) {
        store.set("lastNotifiedForkFailure", failure.id);
        const notification = new Notification({ title: app.name, body: _t("update|actions_build_failed") });
        notification.on(
            "click",
            () => void shell.openExternal(`https://github.com/${repo}/actions/runs/${failure.id}`),
        );
        notification.show();
    }

    const metadata = release?.assets
        .map(({ name }) => /^element-desktop-build-(\d+\.\d+\.\d+)-(\d+)\.(\d+)\.json$/.exec(name))
        .find((match) => match !== null);
    if (!release || !metadata || release.tag_name === store.get("lastNotifiedForkRelease")) return buildFailed;
    if (
        !isNewerForkBuild(installed, { version: metadata[1], run: Number(metadata[2]), attempt: Number(metadata[3]) })
    ) {
        return buildFailed;
    }
    const window = global.mainWindow;
    if (window) {
        store.set("lastNotifiedForkRelease", release.tag_name);
        window.webContents.send("update-downloaded", {
            releaseName: release.tag_name,
            releasePageUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}`,
        });
    }
    return buildFailed;
}

/** Refresh the fork status at most once per minute and keep the last known status on network errors. */
export function getForkBuildFailed(): Promise<boolean> {
    const config = getConfig();
    const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/?$/.exec(
        config.desktop_update_page_url ?? "",
    )?.[1];
    const build = config.desktop_build_number;
    if (!repo || !build) return Promise.resolve(false);
    if (pendingCheck) return pendingCheck;
    if (Date.now() - lastChecked < 60_000) return Promise.resolve(buildFailed);

    lastChecked = Date.now();
    const [run, attempt] = build.split(".").map(Number);
    pendingCheck = check(repo, { version: app.getVersion(), run, attempt })
        .catch((error) => {
            console.warn("Could not check fork updates", error);
            return buildFailed;
        })
        .finally(() => {
            pendingCheck = undefined;
        });
    return pendingCheck;
}
