import {
  App,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
} from "obsidian";
import { StashwiseApi, StashwiseApiError } from "./api";
import {
  type LearnBuildLinkTarget,
  type LearnGuideLinkTarget,
  type RenderMediaContext,
  renderGraphIndex,
  renderHome,
  renderLearnBuildNote,
  renderLearnGuideNote,
  renderLearnHome,
  renderSourceNote,
  renderWikiPage,
  sanitizeFileName,
} from "./markdown";
import type {
  DeviceCodeStartResponse,
  KnownMedia,
  LearnGeneratorContextResponse,
  LearnSyncGuideDetailResponse,
  LearnSyncManifestItem,
  LinkTarget,
  MentionSource,
  SourceLinkTarget,
  StashwiseSettings,
  SyncSummary,
  WikiPageDetailResponse,
  WikiPageListItem,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

const PAGE_LIMIT = 200;
const AUTH_POLL_INTERVAL_MS = 2000;
const PROGRESS_NOTIFY_EVERY = 10;

interface SyncProgressState {
  active: boolean;
  mode: "incremental" | "full";
  phase: string;
  detail: string;
  current: number;
  total: number;
  unit: string;
  startedAt: number;
  phaseStartedAt: number;
  updatedAt: number;
}

interface SourceIndexes {
  sources: MentionSource[];
  sourceBacklinks: Map<string, LinkTarget[]>;
  sourceLinksByContentId: Map<string, SourceLinkTarget>;
  knownSources: StashwiseSettings["knownSources"];
}

interface LearnIndexes {
  knownLearnGuides: StashwiseSettings["knownLearnGuides"];
  knownLearnBuilds: StashwiseSettings["knownLearnBuilds"];
  guideLinksByGuideId: Map<string, LearnGuideLinkTarget>;
  buildLinksByOutputId: Map<string, LearnBuildLinkTarget>;
}

interface SourceMediaItem {
  sourceUrl: string;
  downloadUrl: string;
  role: "thumbnail" | "image";
  index: number;
}

interface MediaSyncResult {
  mediaByUrl: Map<string, string>;
  downloadedContentIds: Set<string>;
}

const IDLE_PROGRESS: SyncProgressState = {
  active: false,
  mode: "incremental",
  phase: "Idle",
  detail: "",
  current: 0,
  total: 0,
  unit: "topics",
  startedAt: 0,
  phaseStartedAt: 0,
  updatedAt: 0,
};

export default class StashwiseSyncPlugin extends Plugin {
  settings: StashwiseSettings = { ...DEFAULT_SETTINGS };
  private api = new StashwiseApi(DEFAULT_SETTINGS.apiBaseUrl, "");
  private syncTimer: number | null = null;
  private syncing = false;
  private syncProgress: SyncProgressState = { ...IDLE_PROGRESS };
  private progressListeners = new Set<() => void>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addRibbonIcon("refresh-cw", "Sync Stashwise wiki", () => {
      void this.syncWiki();
    });

    this.addCommand({
      id: "connect-stashwise",
      name: "Connect Stashwise",
      callback: () => {
        void this.connectStashwise();
      },
    });

    this.addCommand({
      id: "sync-stashwise-wiki",
      name: "Sync Stashwise wiki",
      callback: () => {
        void this.syncWiki();
      },
    });

    this.addCommand({
      id: "full-resync-stashwise-wiki",
      name: "Full resync Stashwise wiki",
      callback: () => {
        void this.syncWiki({ force: true });
      },
    });

    this.addCommand({
      id: "open-stashwise-home",
      name: "Open Stashwise home",
      callback: () => {
        void this.openHome();
      },
    });

    this.addSettingTab(new StashwiseSettingTab(this.app, this));
    this.resetSyncTimer();

    if (this.settings.syncOnStartup && this.settings.authToken) {
      this.app.workspace.onLayoutReady(() => {
        void this.syncWiki({ quiet: true });
      });
    }
  }

  onunload(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<StashwiseSettings> | null;
    const autoSyncMigration =
      data && data.autoSyncConfiguredAt === undefined
        ? {
            syncOnStartup: DEFAULT_SETTINGS.syncOnStartup,
            syncIntervalMinutes: DEFAULT_SETTINGS.syncIntervalMinutes,
          }
        : {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(data ?? {}),
      ...autoSyncMigration,
      knownPages: {
        ...DEFAULT_SETTINGS.knownPages,
        ...(data?.knownPages ?? {}),
      },
      knownSources: {
        ...DEFAULT_SETTINGS.knownSources,
        ...(data?.knownSources ?? {}),
      },
      knownMedia: {
        ...DEFAULT_SETTINGS.knownMedia,
        ...(data?.knownMedia ?? {}),
      },
      knownLearnGuides: {
        ...DEFAULT_SETTINGS.knownLearnGuides,
        ...(data?.knownLearnGuides ?? {}),
      },
      knownLearnBuilds: {
        ...DEFAULT_SETTINGS.knownLearnBuilds,
        ...(data?.knownLearnBuilds ?? {}),
      },
    };
    this.api = new StashwiseApi(this.settings.apiBaseUrl, this.settings.authToken);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.api = new StashwiseApi(this.settings.apiBaseUrl, this.settings.authToken);
  }

  resetSyncTimer(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (!this.settings.authToken || this.settings.syncIntervalMinutes <= 0) {
      return;
    }

    this.syncTimer = window.setInterval(() => {
      void this.syncWiki({ quiet: true });
    }, this.settings.syncIntervalMinutes * 60 * 1000);
  }

  isSyncInProgress(): boolean {
    return this.syncing;
  }

  getSyncProgress(): SyncProgressState {
    return { ...this.syncProgress };
  }

  onProgressChange(listener: () => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  async connectStashwise(): Promise<void> {
    await this.recordAuthStatus(`Starting auth against ${this.settings.apiBaseUrl}`);
    let start: DeviceCodeStartResponse;
    try {
      start = await this.api.startDeviceCode(deviceLabel());
    } catch (error) {
      await this.recordAuthStatus(`Auth start failed: ${errorMessage(error)}`);
      new Notice(`Stashwise auth failed: ${errorMessage(error)}`);
      return;
    }

    const verificationUrl = this.buildVerificationUrl(start);
    await this.recordAuthStatus(`Waiting for approval at ${verificationUrl}`);
    const modal = new DeviceCodeModal(this.app, start, verificationUrl);
    modal.open();

    try {
      window.open(verificationUrl, "_blank");
    } catch {
      // The modal keeps the URL visible for copy/paste if the OS blocks this.
    }

    const deadline = Date.now() + start.expires_in * 1000;
    while (Date.now() < deadline && !modal.cancelled) {
      await sleep(AUTH_POLL_INTERVAL_MS);

      try {
        const poll = await this.api.pollDeviceCode(start.device_code);
        await this.recordAuthStatus(`Poll status: ${poll.status}`);
        if (poll.status === "expired") {
          await this.recordAuthStatus("Authorization expired.");
          new Notice("Stashwise authorization expired. Start again when ready.");
          modal.close();
          return;
        }

        if (poll.status === "authorized" && poll.token) {
          this.settings.authToken = poll.token;
          this.api = this.api.withToken(poll.token);
          const user = poll.user ?? (await this.api.me());
          this.settings.userLabel = user.email ?? user.display_name ?? "Connected account";
          await this.saveSettings();
          this.resetSyncTimer();
          modal.complete();
          await this.recordAuthStatus(`Connected as ${this.settings.userLabel}.`);
          await this.recordSyncStatus("Connected. Click Sync when you are ready to copy your wiki into Obsidian.");
          new Notice(`Connected to Stashwise as ${this.settings.userLabel}.`);
          return;
        }
      } catch (error) {
        if (error instanceof StashwiseApiError && error.status === 404) {
          await this.recordAuthStatus("Authorization expired or device code not found.");
          new Notice("Stashwise authorization expired. Start again when ready.");
          modal.close();
          return;
        }
        await this.recordAuthStatus(`Poll failed: ${errorMessage(error)}`);
      }
    }

    if (!modal.cancelled) {
      await this.recordAuthStatus("Authorization timed out.");
      new Notice("Stashwise authorization timed out.");
      modal.close();
    }
  }

  async syncWiki(
    options: { quiet?: boolean; force?: boolean; cleanupMissing?: boolean } = {},
  ): Promise<void> {
    if (!this.settings.authToken) {
      new Notice("Connect Stashwise before syncing.");
      return;
    }

    if (this.syncing) {
      if (!options.quiet) {
        new Notice("Stashwise sync is already running.");
      }
      return;
    }

    this.syncing = true;
    this.startSyncProgress(options.force ? "full" : "incremental");
    await this.recordSyncStatus(`Sync started against ${this.settings.apiBaseUrl}`);
    if (!options.quiet) {
      new Notice("Syncing Stashwise wiki...");
    }

    try {
      const summary = await this.performSync({
        force: Boolean(options.force),
        cleanupMissing: Boolean(options.cleanupMissing),
      });
      const sourceCount = summary.sourcesCreated + summary.sourcesUpdated + summary.sourcesSkipped;
      const learnCount =
        summary.learnGuidesCreated + summary.learnGuidesUpdated + summary.learnGuidesSkipped;
      await this.recordSyncStatus(
        `Synced ${summary.total} topics, ${sourceCount} source notes, and ${learnCount} Learn guides. Topics: ${summary.created} new, ${summary.updated} updated, ${summary.skipped} unchanged, ${summary.deleted} deleted. Learn: ${summary.learnGuidesCreated} new, ${summary.learnGuidesUpdated} updated, ${summary.learnGuidesSkipped} unchanged. Media: ${summary.mediaDownloaded} downloaded, ${summary.mediaFailed} failed.`,
      );
      this.finishSyncProgress(
        `Synced ${summary.total.toLocaleString()} topics, ${sourceCount.toLocaleString()} source notes, and ${learnCount.toLocaleString()} Learn guides. Media: ${summary.mediaDownloaded.toLocaleString()} downloaded${summary.mediaFailed > 0 ? `, ${summary.mediaFailed.toLocaleString()} failed` : ""}.`,
      );
      if (!options.quiet) {
        new Notice(
          `Stashwise synced ${summary.total} topics and ${learnCount} Learn guides.`,
        );
      }
    } catch (error) {
      await this.recordSyncStatus(`Sync failed: ${errorMessage(error)}`);
      this.failSyncProgress(errorMessage(error));
      new Notice(`Stashwise sync failed: ${errorMessage(error)}`);
    } finally {
      this.syncing = false;
    }
  }

  async openHome(): Promise<void> {
    const homePath = normalizePath(`${this.settings.syncFolder}/Home.md`);
    const file = this.app.vault.getAbstractFileByPath(homePath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }
    new Notice("Stashwise home has not been synced yet.");
  }

  private async performSync(options: {
    force: boolean;
    cleanupMissing: boolean;
  }): Promise<SyncSummary> {
    const syncedAt = new Date().toISOString();
    this.updateSyncProgress({
      phase: "Preparing vault",
      detail: `Writing into ${this.settings.syncFolder}`,
      current: 0,
      total: 0,
      unit: "folders",
    });
    await this.ensureFolder(this.settings.syncFolder);
    await this.ensureFolder(`${this.settings.syncFolder}/Topics`);
    if (this.settings.includeSources) {
      await this.ensureFolder(this.sourceFolderPath());
      if (this.settings.saveImagesLocally) {
        await this.ensureFolder(this.mediaFolderPath());
      }
    }
    if (this.settings.includeLearn) {
      await this.ensureFolder(this.learnFolderPath());
      await this.ensureFolder(this.learnGuidesFolderPath());
      await this.ensureFolder(this.learnBuildsFolderPath());
    }

    const pages = await this.fetchAllPages();
    const { knownPages, linksByEntityId } = this.allocatePaths(pages);
    const seenIds = new Set(pages.map((page) => page.entity_id));
    const sourceBootstrap =
      this.settings.includeSources && Object.keys(this.settings.knownSources).length === 0;
    await this.recordSyncStatus(`Checking ${pages.length.toLocaleString()} Stashwise topics.`);
    this.updateSyncProgress({
      phase: "Checking existing notes",
      detail:
        "Comparing Stashwise wiki timestamps with the notes already in this vault.",
      current: 0,
      total: pages.length,
      unit: "topics",
    });
    const summary: SyncSummary = {
      created: 0,
      updated: 0,
      skipped: 0,
      deleted: 0,
      sourcesCreated: 0,
      sourcesUpdated: 0,
      sourcesSkipped: 0,
      mediaDownloaded: 0,
      mediaSkipped: 0,
      mediaFailed: 0,
      learnGuidesCreated: 0,
      learnGuidesUpdated: 0,
      learnGuidesSkipped: 0,
      learnBuildsCreated: 0,
      learnBuildsUpdated: 0,
      learnBuildsSkipped: 0,
      learnTotal: 0,
      total: pages.length,
    };

    const targets: WikiPageListItem[] = [];
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const known = knownPages[page.entity_id];
      const existing = this.app.vault.getAbstractFileByPath(known.path);
      const alreadyFresh =
        !options.force &&
        !sourceBootstrap &&
        existing instanceof TFile &&
        (known.updatedAt === page.updated_at ||
          (await this.fileHasFreshStashwiseFrontmatter(existing, page)));

      if (alreadyFresh) {
        knownPages[page.entity_id] = {
          ...known,
          name: page.name,
          updatedAt: page.updated_at,
        };
        summary.skipped += 1;
      } else {
        targets.push(page);
      }

      if ((index + 1) % 100 === 0 || index + 1 === pages.length) {
        this.updateSyncProgress({
          phase: "Checking existing notes",
          detail: `${targets.length.toLocaleString()} new or updated in Stashwise, ${summary.skipped.toLocaleString()} already current.`,
          current: index + 1,
          total: pages.length,
          unit: "topics",
        });
      }
    }

    const detailsByEntityId = this.settings.includeSources
      ? await this.fetchPageDetails(pages)
      : new Map<string, WikiPageDetailResponse>();
    const sourceIndexes = this.settings.includeSources
      ? this.buildSourceIndexes(detailsByEntityId, linksByEntityId)
      : {
          sources: [],
          sourceBacklinks: new Map<string, LinkTarget[]>(),
          sourceLinksByContentId: new Map<string, SourceLinkTarget>(),
          knownSources: { ...this.settings.knownSources },
        };
    const mediaSync = this.settings.includeSources
      ? await this.syncSourceMedia(sourceIndexes.sources, summary)
      : {
          mediaByUrl: new Map<string, string>(),
          downloadedContentIds: new Set<string>(),
        };
    const mediaContext: RenderMediaContext = {
      mediaByUrl: mediaSync.mediaByUrl,
      sourceLinksByContentId: sourceIndexes.sourceLinksByContentId,
      embedVideos: this.settings.embedVideos,
    };
    const sourceIdsReferencedByTargets = new Set<string>();
    for (const target of targets) {
      const detail = detailsByEntityId.get(target.entity_id);
      for (const source of detail?.sources ?? []) {
        sourceIdsReferencedByTargets.add(source.content_id);
      }
    }

    if (this.settings.includeSources) {
      await this.syncSourceNotes(
        sourceIndexes,
        mediaContext,
        mediaSync.downloadedContentIds,
        sourceIdsReferencedByTargets,
        syncedAt,
        options.force || sourceBootstrap,
        summary,
      );
    }

    await this.recordSyncStatus(
      targets.length > 0
        ? `Syncing ${targets.length.toLocaleString()} new or updated Stashwise topics; ${(
            summary.skipped
          ).toLocaleString()} already current.`
        : `No new or updated Stashwise topics found. Refreshing indexes.`,
    );
    this.updateSyncProgress({
      phase: targets.length > 0 ? "Syncing new or updated topics" : "Refreshing indexes",
      detail:
        targets.length > 0
          ? `${targets.length.toLocaleString()} Stashwise wiki topics need local Markdown updates.`
          : "Topic notes are already current; refreshing index files.",
      current: 0,
      total: targets.length,
      unit: "topics",
    });

    for (let index = 0; index < targets.length; index += 1) {
      const page = targets[index];
      const known = knownPages[page.entity_id];
      const path = known.path;

      const detail = detailsByEntityId.get(page.entity_id) ?? await this.api.getWikiPage(page.entity_id);
      const content = renderWikiPage(detail, linksByEntityId, {
        includeSources: this.settings.includeSources,
        includeClaims: this.settings.includeClaims,
        media: mediaContext,
      });
      const result = await this.writeMarkdown(path, content);
      if (result === "created") {
        summary.created += 1;
      } else if (result === "updated") {
        summary.updated += 1;
      } else {
        summary.skipped += 1;
      }
      knownPages[page.entity_id] = {
        ...known,
        name: detail.name,
        updatedAt: detail.updated_at,
      };

      if ((index + 1) % PROGRESS_NOTIFY_EVERY === 0 || index + 1 === targets.length) {
        this.updateSyncProgress({
          phase: "Syncing new or updated topics",
          detail: `${summary.created.toLocaleString()} new, ${summary.updated.toLocaleString()} updated, ${summary.skipped.toLocaleString()} unchanged.`,
          current: index + 1,
          total: targets.length,
          unit: "topics",
        });
      }

      if ((index + 1) % 25 === 0 || index + 1 === targets.length) {
        await this.recordSyncStatus(
          `Synced ${(index + 1).toLocaleString()} of ${targets.length.toLocaleString()} new or updated Stashwise topics.`,
        );
      }
    }

    const shouldDeleteMissing = this.settings.deleteMissing || options.cleanupMissing;
    if (shouldDeleteMissing) {
      const missing = Object.entries(knownPages).filter(([entityId]) => !seenIds.has(entityId));
      this.updateSyncProgress({
        phase: "Removing missing topics",
        detail: "Moving local topic notes to trash when they disappeared from Stashwise.",
        current: 0,
        total: missing.length,
        unit: "topics",
      });
      for (let index = 0; index < missing.length; index += 1) {
        const [entityId, known] = missing[index];
        if (!seenIds.has(entityId)) {
          const file = this.app.vault.getAbstractFileByPath(known.path);
          if (file instanceof TFile) {
            await this.app.vault.trash(file, true);
            summary.deleted += 1;
          }
          delete knownPages[entityId];
        }
        if ((index + 1) % PROGRESS_NOTIFY_EVERY === 0 || index + 1 === missing.length) {
          this.updateSyncProgress({
            phase: "Removing missing topics",
            detail: `${summary.deleted.toLocaleString()} local notes moved to trash.`,
            current: index + 1,
            total: missing.length,
            unit: "topics",
          });
        }
      }
    }

    const learnGuideCount = this.settings.includeLearn
      ? await this.syncLearn(
          linksByEntityId,
          sourceIndexes.sourceLinksByContentId,
          syncedAt,
          options.force,
          summary,
        )
      : 0;

    const indexTotal = this.settings.writeGraphIndex ? 2 : 1;
    this.updateSyncProgress({
      phase: "Refreshing indexes",
      detail: "Writing Home.md.",
      current: 0,
      total: indexTotal,
      unit: "files",
    });
    await this.writeMarkdown(
      normalizePath(`${this.settings.syncFolder}/Home.md`),
      renderHome(
        pages,
        linksByEntityId,
        syncedAt,
        learnGuideCount > 0
          ? {
              guideCount: learnGuideCount,
              homePath: normalizePath(`${this.learnFolderPath()}/Home.md`),
            }
          : undefined,
      ),
    );
    this.updateSyncProgress({
      phase: "Refreshing indexes",
      detail: this.settings.writeGraphIndex ? "Writing Graph.md." : "Index files refreshed.",
      current: 1,
      total: indexTotal,
      unit: "files",
    });

    if (this.settings.writeGraphIndex) {
      const graph = await this.api.getWikiGraph();
      await this.writeMarkdown(
        normalizePath(`${this.settings.syncFolder}/Graph.md`),
        renderGraphIndex(graph, linksByEntityId, syncedAt),
      );
      this.updateSyncProgress({
        phase: "Refreshing indexes",
        detail: "Index files refreshed.",
        current: 2,
        total: indexTotal,
        unit: "files",
      });
    }

    this.settings.knownPages = knownPages;
    this.settings.knownSources = sourceIndexes.knownSources;
    this.settings.lastSyncAt = syncedAt;
    await this.saveSettings();
    return summary;
  }

  private async fetchAllPages(): Promise<WikiPageListItem[]> {
    const pages: WikiPageListItem[] = [];
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    this.updateSyncProgress({
      phase: "Fetching topic list",
      detail: "Asking Stashwise which published wiki topics exist.",
      current: 0,
      total: 0,
      unit: "topics",
    });

    while (pages.length < total) {
      const response = await this.api.listWikiPages(skip, PAGE_LIMIT);
      pages.push(...response.items);
      total = response.total;
      this.updateSyncProgress({
        phase: "Fetching topic list",
        detail: `${pages.length.toLocaleString()} of ${total.toLocaleString()} published topics found.`,
        current: pages.length,
        total,
        unit: "topics",
      });
      if (response.items.length === 0) {
        break;
      }
      skip += response.items.length;
    }

    return pages;
  }

  private async fetchPageDetails(
    pages: WikiPageListItem[],
  ): Promise<Map<string, WikiPageDetailResponse>> {
    const details = new Map<string, WikiPageDetailResponse>();
    this.updateSyncProgress({
      phase: "Fetching source details",
      detail: "Loading Stashwise analysis and media for published topics.",
      current: 0,
      total: pages.length,
      unit: "topics",
    });

    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const detail = await this.api.getWikiPage(page.entity_id);
      details.set(page.entity_id, detail);
      if ((index + 1) % PROGRESS_NOTIFY_EVERY === 0 || index + 1 === pages.length) {
        this.updateSyncProgress({
          phase: "Fetching source details",
          detail: `${(index + 1).toLocaleString()} of ${pages.length.toLocaleString()} topic source lists loaded.`,
          current: index + 1,
          total: pages.length,
          unit: "topics",
        });
      }
    }

    return details;
  }

  private buildSourceIndexes(
    detailsByEntityId: Map<string, WikiPageDetailResponse>,
    linksByEntityId: Map<string, LinkTarget>,
  ): SourceIndexes {
    const sourcesByContentId = new Map<string, MentionSource>();
    const sourceBacklinks = new Map<string, LinkTarget[]>();
    for (const detail of detailsByEntityId.values()) {
      const topicLink = linksByEntityId.get(detail.entity_id);
      for (const source of detail.sources ?? []) {
        if (!sourcesByContentId.has(source.content_id)) {
          sourcesByContentId.set(source.content_id, source);
        }
        if (topicLink) {
          const backlinks = sourceBacklinks.get(source.content_id) ?? [];
          if (!backlinks.some((link) => link.entityId === topicLink.entityId)) {
            backlinks.push(topicLink);
          }
          sourceBacklinks.set(source.content_id, backlinks);
        }
      }
    }

    const sources = [...sourcesByContentId.values()].sort((a, b) =>
      sourceTitle(a).localeCompare(sourceTitle(b)),
    );
    const knownSources = { ...this.settings.knownSources };
    const sourceLinksByContentId = new Map<string, SourceLinkTarget>();
    const usedPaths = new Set(
      Object.values(knownSources)
        .map((known) => normalizePath(known.path))
        .filter((path) => this.isInSyncFolder(path)),
    );

    for (const source of sources) {
      const existing = knownSources[source.content_id];
      const existingPath = existing?.path ? normalizePath(existing.path) : "";
      const path = existingPath && this.isInSyncFolder(existingPath)
        ? existingPath
        : this.nextSourcePath(source, usedPaths);
      usedPaths.add(path);
      const title = sourceTitle(source);
      knownSources[source.content_id] = {
        title,
        path,
        updatedAt: existing?.updatedAt ?? "",
      };
      sourceLinksByContentId.set(source.content_id, {
        contentId: source.content_id,
        title,
        path,
      });
    }

    return {
      sources,
      sourceBacklinks,
      sourceLinksByContentId,
      knownSources,
    };
  }

  private async syncSourceMedia(
    sources: MentionSource[],
    summary: SyncSummary,
  ): Promise<MediaSyncResult> {
    const mediaByUrl = new Map<string, string>();
    const downloadedContentIds = new Set<string>();
    if (!this.settings.saveImagesLocally) {
      return { mediaByUrl, downloadedContentIds };
    }

    const knownMedia = { ...this.settings.knownMedia };
    const items = sources.flatMap((source) =>
      this.sourceMediaItems(source).map((item) => ({ source, item })),
    );
    this.updateSyncProgress({
      phase: "Syncing media",
      detail: items.length > 0
        ? "Saving source images into this Obsidian vault."
        : "No source images found for local media sync.",
      current: 0,
      total: items.length,
      unit: "images",
    });

    for (let index = 0; index < items.length; index += 1) {
      const { source, item } = items[index];
      const key = mediaKey(source.content_id, item.sourceUrl);
      const known = knownMedia[key];
      if (known && await this.fileExists(known.path)) {
        mediaByUrl.set(item.sourceUrl, known.path);
        summary.mediaSkipped += 1;
      } else {
        try {
          const downloaded = await this.downloadSourceImage(source, item);
          knownMedia[key] = downloaded;
          mediaByUrl.set(item.sourceUrl, downloaded.path);
          downloadedContentIds.add(source.content_id);
          summary.mediaDownloaded += 1;
        } catch (error) {
          summary.mediaFailed += 1;
          console.warn(
            `[Stashwise Sync] Could not save media ${item.downloadUrl}: ${errorMessage(error)}`,
          );
        }
      }

      if ((index + 1) % PROGRESS_NOTIFY_EVERY === 0 || index + 1 === items.length) {
        this.updateSyncProgress({
          phase: "Syncing media",
          detail: `${summary.mediaDownloaded.toLocaleString()} downloaded, ${summary.mediaSkipped.toLocaleString()} already local, ${summary.mediaFailed.toLocaleString()} failed.`,
          current: index + 1,
          total: items.length,
          unit: "images",
        });
      }
    }

    this.settings.knownMedia = knownMedia;
    return { mediaByUrl, downloadedContentIds };
  }

  private async syncSourceNotes(
    indexes: SourceIndexes,
    media: RenderMediaContext,
    downloadedContentIds: Set<string>,
    sourceIdsReferencedByTargets: Set<string>,
    syncedAt: string,
    force: boolean,
    summary: SyncSummary,
  ): Promise<void> {
    this.updateSyncProgress({
      phase: "Writing source notes",
      detail: "Writing one reusable note for each saved Stashwise source.",
      current: 0,
      total: indexes.sources.length,
      unit: "sources",
    });

    for (let index = 0; index < indexes.sources.length; index += 1) {
      const source = indexes.sources[index];
      const known = indexes.knownSources[source.content_id];
      const updatedAt = sourceUpdatedAt(source);
      const existing = this.app.vault.getAbstractFileByPath(known.path);
      const alreadyFresh =
        !force &&
        !downloadedContentIds.has(source.content_id) &&
        !sourceIdsReferencedByTargets.has(source.content_id) &&
        existing instanceof TFile &&
        (known.updatedAt === updatedAt ||
          frontmatterValue(await this.app.vault.cachedRead(existing), "stashwise_updated_at") === updatedAt);

      if (alreadyFresh) {
        indexes.knownSources[source.content_id] = {
          ...known,
          title: sourceTitle(source),
          updatedAt,
        };
        summary.sourcesSkipped += 1;
      } else {
        const content = renderSourceNote(
          source,
          indexes.sourceBacklinks.get(source.content_id) ?? [],
          media,
          syncedAt,
        );
        const result = await this.writeMarkdown(known.path, content);
        if (result === "created") {
          summary.sourcesCreated += 1;
        } else if (result === "updated") {
          summary.sourcesUpdated += 1;
        } else {
          summary.sourcesSkipped += 1;
        }
        indexes.knownSources[source.content_id] = {
          ...known,
          title: sourceTitle(source),
          updatedAt,
        };
      }

      if ((index + 1) % PROGRESS_NOTIFY_EVERY === 0 || index + 1 === indexes.sources.length) {
        this.updateSyncProgress({
          phase: "Writing source notes",
          detail: `${summary.sourcesCreated.toLocaleString()} new, ${summary.sourcesUpdated.toLocaleString()} updated, ${summary.sourcesSkipped.toLocaleString()} unchanged.`,
          current: index + 1,
          total: indexes.sources.length,
          unit: "sources",
        });
      }
    }
  }

  private async syncLearn(
    linksByEntityId: Map<string, LinkTarget>,
    sourceLinksByContentId: Map<string, SourceLinkTarget>,
    syncedAt: string,
    force: boolean,
    summary: SyncSummary,
  ): Promise<number> {
    const manifest = await this.fetchAllLearnManifest();
    summary.learnTotal = manifest.length;
    const indexes = this.allocateLearnGuidePaths(manifest);
    const targets: LearnSyncManifestItem[] = [];
    this.updateSyncProgress({
      phase: "Checking Learn notes",
      detail: "Comparing generated Learn guide timestamps with local notes.",
      current: 0,
      total: manifest.length,
      unit: "guides",
    });

    for (let index = 0; index < manifest.length; index += 1) {
      const item = manifest[index];
      const known = indexes.knownLearnGuides[item.guide_id];
      const existing = this.app.vault.getAbstractFileByPath(known.path);
      const alreadyFresh =
        !force &&
        existing instanceof TFile &&
        (known.updatedAt === item.sync_updated_at ||
          (await this.fileHasFreshStashwiseMetadata(
            existing,
            item.guide_id,
            item.sync_updated_at,
          )));

      if (alreadyFresh) {
        summary.learnGuidesSkipped += 1;
      } else {
        targets.push(item);
      }

      if ((index + 1) % PROGRESS_NOTIFY_EVERY === 0 || index + 1 === manifest.length) {
        this.updateSyncProgress({
          phase: "Checking Learn notes",
          detail: `${targets.length.toLocaleString()} Learn guides need local updates, ${summary.learnGuidesSkipped.toLocaleString()} already current.`,
          current: index + 1,
          total: manifest.length,
          unit: "guides",
        });
      }
    }

    this.updateSyncProgress({
      phase: "Syncing Learn guides",
      detail: targets.length > 0
        ? "Writing generated Learn process, battle, and build notes."
        : "Learn guide notes are current; refreshing Learn index.",
      current: 0,
      total: targets.length,
      unit: "guides",
    });

    for (let index = 0; index < targets.length; index += 1) {
      const item = targets[index];
      const known = indexes.knownLearnGuides[item.guide_id];
      const detail = await this.api.getLearnSyncGuide(item.guide_id);
      const buildLink = detail.build_output
        ? this.ensureLearnBuildPath(detail.build_output, indexes)
        : null;
      const content = renderLearnGuideNote(detail, {
        topicLinksByEntityId: linksByEntityId,
        sourceLinksByContentId,
        buildLink,
        syncedAt,
      });
      const result = await this.writeMarkdown(known.path, content);
      if (result === "created") {
        summary.learnGuidesCreated += 1;
      } else if (result === "updated") {
        summary.learnGuidesUpdated += 1;
      } else {
        summary.learnGuidesSkipped += 1;
      }
      indexes.knownLearnGuides[item.guide_id] = {
        ...known,
        title: detail.guide.title,
        updatedAt: detail.sync_updated_at,
        buildOutputId: detail.build_output?.id ?? null,
      };
      if (detail.build_output && buildLink) {
        await this.syncLearnBuildNote(
          detail,
          indexes,
          buildLink,
          syncedAt,
          force,
          summary,
        );
      }

      if ((index + 1) % PROGRESS_NOTIFY_EVERY === 0 || index + 1 === targets.length) {
        this.updateSyncProgress({
          phase: "Syncing Learn guides",
          detail: `${summary.learnGuidesCreated.toLocaleString()} new, ${summary.learnGuidesUpdated.toLocaleString()} updated, ${summary.learnGuidesSkipped.toLocaleString()} unchanged.`,
          current: index + 1,
          total: targets.length,
          unit: "guides",
        });
      }
    }

    let generatorContext: LearnGeneratorContextResponse | null = null;
    try {
      generatorContext = await this.api.getLearnGeneratorContext();
    } catch (error) {
      console.warn(`[Stashwise Sync] Could not load Learn generator context: ${errorMessage(error)}`);
    }
    await this.writeMarkdown(
      normalizePath(`${this.learnFolderPath()}/Home.md`),
      renderLearnHome(manifest, indexes.guideLinksByGuideId, generatorContext, syncedAt),
    );

    this.settings.knownLearnGuides = indexes.knownLearnGuides;
    this.settings.knownLearnBuilds = indexes.knownLearnBuilds;
    return manifest.length;
  }

  private async syncLearnBuildNote(
    detail: LearnSyncGuideDetailResponse,
    indexes: LearnIndexes,
    buildLink: LearnBuildLinkTarget,
    syncedAt: string,
    force: boolean,
    summary: SyncSummary,
  ): Promise<void> {
    const output = detail.build_output;
    if (!output) {
      return;
    }
    const known = indexes.knownLearnBuilds[output.id];
    const existing = this.app.vault.getAbstractFileByPath(known.path);
    const alreadyFresh =
      !force &&
      existing instanceof TFile &&
      (known.updatedAt === output.updated_at ||
        (await this.fileHasFreshStashwiseMetadata(existing, output.id, output.updated_at)));
    if (alreadyFresh) {
      summary.learnBuildsSkipped += 1;
      return;
    }
    const guideLink = indexes.guideLinksByGuideId.get(detail.guide.id) ?? null;
    const result = await this.writeMarkdown(
      buildLink.path,
      renderLearnBuildNote(output, guideLink, syncedAt),
    );
    if (result === "created") {
      summary.learnBuildsCreated += 1;
    } else if (result === "updated") {
      summary.learnBuildsUpdated += 1;
    } else {
      summary.learnBuildsSkipped += 1;
    }
    indexes.knownLearnBuilds[output.id] = {
      ...known,
      title: output.title,
      updatedAt: output.updated_at,
    };
  }

  private async fetchAllLearnManifest(): Promise<LearnSyncManifestItem[]> {
    const items: LearnSyncManifestItem[] = [];
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    this.updateSyncProgress({
      phase: "Fetching Learn manifest",
      detail: "Asking Stashwise which generated Learn guides exist.",
      current: 0,
      total: 0,
      unit: "guides",
    });

    while (items.length < total) {
      const response = await this.api.listLearnSyncManifest(skip, PAGE_LIMIT);
      items.push(...response.items);
      total = response.total;
      this.updateSyncProgress({
        phase: "Fetching Learn manifest",
        detail: `${items.length.toLocaleString()} of ${total.toLocaleString()} Learn guides found.`,
        current: items.length,
        total,
        unit: "guides",
      });
      if (response.items.length === 0) {
        break;
      }
      skip += response.items.length;
    }
    return items;
  }

  private allocatePaths(pages: WikiPageListItem[]): {
    knownPages: StashwiseSettings["knownPages"];
    linksByEntityId: Map<string, LinkTarget>;
  } {
    const knownPages = { ...this.settings.knownPages };
    const linksByEntityId = new Map<string, LinkTarget>();
    const usedPaths = new Set(
      Object.values(knownPages)
        .map((known) => normalizePath(known.path))
        .filter((path) => this.isInSyncFolder(path)),
    );

    for (const page of pages) {
      const existing = knownPages[page.entity_id];
      const existingPath = existing?.path ? normalizePath(existing.path) : "";
      const path = existingPath && this.isInSyncFolder(existingPath)
        ? existingPath
        : this.nextTopicPath(page, usedPaths);

      usedPaths.add(path);
      knownPages[page.entity_id] = {
        name: page.name,
        path,
        updatedAt: existing?.updatedAt ?? "",
      };
      linksByEntityId.set(page.entity_id, {
        entityId: page.entity_id,
        name: page.name,
        path,
      });
    }

    return { knownPages, linksByEntityId };
  }

  private allocateLearnGuidePaths(items: LearnSyncManifestItem[]): LearnIndexes {
    const knownLearnGuides = { ...this.settings.knownLearnGuides };
    const knownLearnBuilds = { ...this.settings.knownLearnBuilds };
    const guideLinksByGuideId = new Map<string, LearnGuideLinkTarget>();
    const buildLinksByOutputId = new Map<string, LearnBuildLinkTarget>();
    const usedGuidePaths = new Set(
      Object.values(knownLearnGuides)
        .map((known) => normalizePath(known.path))
        .filter((path) => this.isInSyncFolder(path)),
    );

    for (const item of items) {
      const existing = knownLearnGuides[item.guide_id];
      const existingPath = existing?.path ? normalizePath(existing.path) : "";
      const path = existingPath && this.isInSyncFolder(existingPath)
        ? existingPath
        : this.nextLearnGuidePath(item, usedGuidePaths);
      usedGuidePaths.add(path);
      knownLearnGuides[item.guide_id] = {
        title: item.title,
        path,
        updatedAt: existing?.updatedAt ?? "",
        buildOutputId: item.build_output_id ?? existing?.buildOutputId ?? null,
      };
      guideLinksByGuideId.set(item.guide_id, {
        guideId: item.guide_id,
        title: item.title,
        path,
      });
    }

    for (const [outputId, known] of Object.entries(knownLearnBuilds)) {
      if (known.path && this.isInSyncFolder(known.path)) {
        buildLinksByOutputId.set(outputId, {
          outputId,
          title: known.title,
          path: normalizePath(known.path),
        });
      }
    }

    return {
      knownLearnGuides,
      knownLearnBuilds,
      guideLinksByGuideId,
      buildLinksByOutputId,
    };
  }

  private ensureLearnBuildPath(
    output: NonNullable<LearnSyncGuideDetailResponse["build_output"]>,
    indexes: LearnIndexes,
  ): LearnBuildLinkTarget {
    const existing = indexes.knownLearnBuilds[output.id];
    const existingPath = existing?.path ? normalizePath(existing.path) : "";
    if (existingPath && this.isInSyncFolder(existingPath)) {
      const target = {
        outputId: output.id,
        title: output.title,
        path: existingPath,
      };
      indexes.buildLinksByOutputId.set(output.id, target);
      return target;
    }

    const usedPaths = new Set(
      Object.values(indexes.knownLearnBuilds)
        .map((known) => normalizePath(known.path))
        .filter((path) => this.isInSyncFolder(path)),
    );
    const path = this.nextLearnBuildPath(output, usedPaths);
    indexes.knownLearnBuilds[output.id] = {
      title: output.title,
      path,
      updatedAt: existing?.updatedAt ?? "",
    };
    const target = {
      outputId: output.id,
      title: output.title,
      path,
    };
    indexes.buildLinksByOutputId.set(output.id, target);
    return target;
  }

  private isInSyncFolder(path: string): boolean {
    const folder = normalizePath(this.settings.syncFolder);
    const normalizedPath = normalizePath(path);
    return normalizedPath === folder || normalizedPath.startsWith(`${folder}/`);
  }

  private nextTopicPath(page: WikiPageListItem, usedPaths: Set<string>): string {
    const baseName = sanitizeFileName(page.name);
    const basePath = normalizePath(`${this.settings.syncFolder}/Topics/${baseName}.md`);
    if (!usedPaths.has(basePath)) {
      return basePath;
    }

    const shortId = page.entity_id.slice(0, 8);
    let candidate = normalizePath(
      `${this.settings.syncFolder}/Topics/${baseName}-${shortId}.md`,
    );
    let counter = 2;
    while (usedPaths.has(candidate)) {
      candidate = normalizePath(
        `${this.settings.syncFolder}/Topics/${baseName}-${shortId}-${counter}.md`,
      );
      counter += 1;
    }
    return candidate;
  }

  private nextSourcePath(source: MentionSource, usedPaths: Set<string>): string {
    const baseName = sanitizeFileName(sourceTitle(source));
    const shortId = sanitizeFileName(source.content_id.slice(0, 8));
    const basePath = normalizePath(`${this.sourceFolderPath()}/${baseName}-${shortId}.md`);
    if (!usedPaths.has(basePath)) {
      return basePath;
    }

    let counter = 2;
    let candidate = normalizePath(`${this.sourceFolderPath()}/${baseName}-${shortId}-${counter}.md`);
    while (usedPaths.has(candidate)) {
      counter += 1;
      candidate = normalizePath(`${this.sourceFolderPath()}/${baseName}-${shortId}-${counter}.md`);
    }
    return candidate;
  }

  private nextLearnGuidePath(
    item: LearnSyncManifestItem,
    usedPaths: Set<string>,
  ): string {
    const baseName = sanitizeFileName(item.title);
    const shortId = sanitizeFileName(item.guide_id.slice(0, 8));
    const basePath = normalizePath(`${this.learnGuidesFolderPath()}/${baseName}-${shortId}.md`);
    if (!usedPaths.has(basePath)) {
      return basePath;
    }

    let counter = 2;
    let candidate = normalizePath(
      `${this.learnGuidesFolderPath()}/${baseName}-${shortId}-${counter}.md`,
    );
    while (usedPaths.has(candidate)) {
      counter += 1;
      candidate = normalizePath(
        `${this.learnGuidesFolderPath()}/${baseName}-${shortId}-${counter}.md`,
      );
    }
    return candidate;
  }

  private nextLearnBuildPath(
    output: NonNullable<LearnSyncGuideDetailResponse["build_output"]>,
    usedPaths: Set<string>,
  ): string {
    const baseName = sanitizeFileName(output.title);
    const shortId = sanitizeFileName(output.id.slice(0, 8));
    const basePath = normalizePath(`${this.learnBuildsFolderPath()}/${baseName}-${shortId}.md`);
    if (!usedPaths.has(basePath)) {
      usedPaths.add(basePath);
      return basePath;
    }

    let counter = 2;
    let candidate = normalizePath(
      `${this.learnBuildsFolderPath()}/${baseName}-${shortId}-${counter}.md`,
    );
    while (usedPaths.has(candidate)) {
      counter += 1;
      candidate = normalizePath(
        `${this.learnBuildsFolderPath()}/${baseName}-${shortId}-${counter}.md`,
      );
    }
    usedPaths.add(candidate);
    return candidate;
  }

  private sourceFolderPath(): string {
    return normalizePath(`${this.settings.syncFolder}/Sources`);
  }

  private learnFolderPath(): string {
    return normalizePath(`${this.settings.syncFolder}/Learn`);
  }

  private learnGuidesFolderPath(): string {
    return normalizePath(`${this.learnFolderPath()}/Guides`);
  }

  private learnBuildsFolderPath(): string {
    return normalizePath(`${this.learnFolderPath()}/Builds`);
  }

  private mediaFolderPath(): string {
    const mediaFolder = normalizePath(this.settings.mediaFolder || DEFAULT_SETTINGS.mediaFolder);
    if (!mediaFolder || mediaFolder === ".") {
      return normalizePath(`${this.settings.syncFolder}/${DEFAULT_SETTINGS.mediaFolder}`);
    }
    if (this.isInSyncFolder(mediaFolder)) {
      return mediaFolder;
    }
    return normalizePath(`${this.settings.syncFolder}/${mediaFolder}`);
  }

  private sourceMediaItems(source: MentionSource): SourceMediaItem[] {
    const items: SourceMediaItem[] = [];
    const seen = new Set<string>();
    const add = (
      role: SourceMediaItem["role"],
      index: number,
      sourceUrl: string | null | undefined,
      downloadUrl: string | null | undefined,
    ) => {
      const cleanSourceUrl = sourceUrl?.trim();
      const cleanDownloadUrl = downloadUrl?.trim() || cleanSourceUrl;
      if (!cleanSourceUrl || !cleanDownloadUrl || seen.has(cleanSourceUrl)) {
        return;
      }
      seen.add(cleanSourceUrl);
      items.push({
        sourceUrl: cleanSourceUrl,
        downloadUrl: this.withImageSettings(cleanDownloadUrl),
        role,
        index,
      });
    };

    add("thumbnail", 0, source.thumbnail_url, source.thumbnail_download_url);
    for (let index = 0; index < (source.images ?? []).length; index += 1) {
      add("image", index, source.images[index], source.image_download_urls?.[index]);
    }
    return items;
  }

  private withImageSettings(url: string): string {
    if (!url.includes("/api/v1/media/")) {
      return url;
    }
    try {
      const next = new URL(url);
      next.searchParams.set("format", "jpeg");
      next.searchParams.set("max_width", String(this.settings.imageMaxWidth));
      next.searchParams.set("quality", String(this.settings.imageJpegQuality));
      return next.toString();
    } catch {
      return url;
    }
  }

  private async downloadSourceImage(
    source: MentionSource,
    item: SourceMediaItem,
  ): Promise<KnownMedia> {
    const response = await requestUrl({
      url: item.downloadUrl,
      headers: { Accept: "image/*" },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = headerValue(response.headers, "content-type") ?? "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`Expected image response, got ${contentType}`);
    }

    const ext = imageExtension(contentType, item.downloadUrl);
    const baseName = item.role === "thumbnail" ? "thumbnail" : `image-${item.index + 1}`;
    const mediaPath = normalizePath(
      `${this.mediaFolderPath()}/${sanitizeFileName(source.content_id)}/${baseName}.${ext}`,
    );
    await this.writeBinary(mediaPath, response.arrayBuffer);
    return {
      sourceUrl: item.sourceUrl,
      downloadUrl: item.downloadUrl,
      path: mediaPath,
      downloadedAt: new Date().toISOString(),
      byteLength: response.arrayBuffer.byteLength,
    };
  }

  private async writeMarkdown(
    path: string,
    content: string,
  ): Promise<"created" | "updated" | "unchanged"> {
    const normalizedPath = normalizePath(path);
    await this.ensureParentFolder(normalizedPath);
    const existing = this.app.vault.getAbstractFileByPath(normalizedPath);

    if (existing instanceof TFile) {
      const current = await this.app.vault.cachedRead(existing);
      if (current === content) {
        return "unchanged";
      }
      await this.app.vault.modify(existing, content);
      return "updated";
    }

    if (existing) {
      throw new Error(`${normalizedPath} exists but is not a Markdown file.`);
    }

    try {
      await this.app.vault.create(normalizedPath, content);
      return "created";
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const file = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (file instanceof TFile) {
        const current = await this.app.vault.cachedRead(file);
        if (current === content) {
          return "unchanged";
        }
        await this.app.vault.modify(file, content);
        return "updated";
      }

      if (await this.app.vault.adapter.exists(normalizedPath)) {
        await this.app.vault.adapter.write(normalizedPath, content);
        return "updated";
      }

      throw error;
    }
  }

  private async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const normalizedPath = normalizePath(path);
    await this.ensureParentFolder(normalizedPath);
    const existing = this.app.vault.getAbstractFileByPath(normalizedPath);

    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
      return;
    }

    if (existing) {
      throw new Error(`${normalizedPath} exists but is not a file.`);
    }

    try {
      await this.app.vault.createBinary(normalizedPath, data);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const file = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (file instanceof TFile) {
        await this.app.vault.modifyBinary(file, data);
        return;
      }

      await this.app.vault.adapter.writeBinary(normalizedPath, data);
    }
  }

  private async ensureParentFolder(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash === -1) {
      return;
    }
    await this.ensureFolder(filePath.slice(0, lastSlash));
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const normalizedPath = normalizePath(folderPath);
    if (!normalizedPath) {
      return;
    }

    const parts = normalizedPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) {
        throw new Error(`${current} exists but is a file.`);
      }
      if (!existing) {
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          if (!isAlreadyExistsError(error) || !(await this.app.vault.adapter.exists(current))) {
            throw error;
          }
        }
      }
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile;
  }

  private async fileHasFreshStashwiseFrontmatter(
    file: TFile,
    page: WikiPageListItem,
  ): Promise<boolean> {
    const current = await this.app.vault.cachedRead(file);
    return (
      frontmatterValue(current, "stashwise_id") === page.entity_id &&
      frontmatterValue(current, "stashwise_updated_at") === page.updated_at
    );
  }

  private async fileHasFreshStashwiseMetadata(
    file: TFile,
    stashwiseId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const current = await this.app.vault.cachedRead(file);
    return (
      frontmatterValue(current, "stashwise_id") === stashwiseId &&
      frontmatterValue(current, "stashwise_updated_at") === updatedAt
    );
  }

  private async recordAuthStatus(statusText: string): Promise<void> {
    this.settings.lastAuthStatus = `${formatLocalDateTime(new Date().toISOString())} - ${statusText}`;
    await this.saveSettings();
    console.info(`[Stashwise Sync] ${this.settings.lastAuthStatus}`);
    this.notifyProgressListeners();
  }

  private async recordSyncStatus(statusText: string): Promise<void> {
    this.settings.lastSyncStatus = `${formatLocalDateTime(new Date().toISOString())} - ${statusText}`;
    await this.saveSettings();
    console.info(`[Stashwise Sync] ${this.settings.lastSyncStatus}`);
    this.notifyProgressListeners();
  }

  private startSyncProgress(mode: SyncProgressState["mode"]): void {
    const now = Date.now();
    this.syncProgress = {
      active: true,
      mode,
      phase: mode === "full" ? "Starting full resync" : "Starting sync",
      detail:
        mode === "full"
          ? "Every Stashwise wiki topic will be checked and rewritten if needed."
          : "Only new or updated Stashwise wiki topics will be fetched and written.",
      current: 0,
      total: 0,
      unit: "topics",
      startedAt: now,
      phaseStartedAt: now,
      updatedAt: now,
    };
    this.notifyProgressListeners();
  }

  private updateSyncProgress(update: Partial<SyncProgressState>): void {
    const phase = update.phase ?? this.syncProgress.phase;
    const now = Date.now();
    this.syncProgress = {
      ...this.syncProgress,
      ...update,
      phase,
      phaseStartedAt: phase === this.syncProgress.phase ? this.syncProgress.phaseStartedAt : now,
      updatedAt: now,
    };
    this.notifyProgressListeners();
  }

  private finishSyncProgress(detail: string): void {
    this.updateSyncProgress({
      active: false,
      phase: "Sync complete",
      detail,
      current: 1,
      total: 1,
      unit: "sync",
    });
  }

  private failSyncProgress(detail: string): void {
    this.updateSyncProgress({
      active: false,
      phase: "Sync failed",
      detail,
    });
  }

  private notifyProgressListeners(): void {
    for (const listener of this.progressListeners) {
      listener();
    }
  }

  private buildVerificationUrl(start: DeviceCodeStartResponse): string {
    const fallback = start.verification_uri;
    const base = this.settings.webBaseUrl.trim();
    if (!base) {
      return fallback;
    }

    try {
      const url = new URL("/cli", base.replace(/\/+$/, ""));
      url.searchParams.set("code", start.user_code);
      return url.toString();
    } catch {
      return fallback;
    }
  }
}

class DeviceCodeModal extends Modal {
  cancelled = false;
  private completed = false;

  constructor(
    app: App,
    private readonly start: DeviceCodeStartResponse,
    private readonly verificationUrl: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Connect Stashwise" });
    contentEl.createEl("p", {
      text: "Open the authorization page, sign in, and confirm this Obsidian vault.",
    });
    contentEl.createEl("p", { text: this.verificationUrl });
    contentEl.createEl("p", { text: "Code:" });
    contentEl.createEl("code", { text: this.start.user_code });

    const actions = contentEl.createDiv();
    const openButton = actions.createEl("button", { text: "Open Stashwise" });
    openButton.addEventListener("click", () => {
      window.open(this.verificationUrl, "_blank");
    });

    const copyButton = actions.createEl("button", { text: "Copy URL" });
    copyButton.addEventListener("click", () => {
      void navigator.clipboard?.writeText(this.verificationUrl);
      new Notice("Stashwise authorization URL copied.");
    });

    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => {
      this.cancelled = true;
      this.close();
    });
  }

  complete(): void {
    this.completed = true;
    this.close();
  }

  onClose(): void {
    if (!this.completed) {
      this.cancelled = true;
    }
    this.contentEl.empty();
  }
}

class StashwiseSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: StashwiseSyncPlugin,
  ) {
    super(app, plugin);
    const unsubscribe = plugin.onProgressChange(() => {
      this.display();
    });
    plugin.register(unsubscribe);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Stashwise Sync" });

    new Setting(containerEl)
      .setName("Account")
      .setDesc(this.plugin.settings.userLabel || "Not connected")
      .addButton((button) =>
        button
          .setButtonText(this.plugin.settings.authToken ? "Reconnect" : "Connect")
          .setCta()
          .onClick(async () => {
            await this.plugin.connectStashwise();
            this.display();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Forget")
          .setDisabled(!this.plugin.settings.authToken)
          .onClick(async () => {
            this.plugin.settings.authToken = "";
            this.plugin.settings.userLabel = "";
            await this.plugin.saveSettings();
            this.plugin.resetSyncTimer();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc(
        `${formatLastSync(
          this.plugin.settings.lastSyncAt,
        )}. First sync can take a few minutes for a large wiki; progress appears below.`,
      )
      .addButton((button) =>
        button
          .setButtonText("Sync")
          .setDisabled(!this.plugin.settings.authToken || this.plugin.isSyncInProgress())
          .onClick(async () => {
            await this.plugin.syncWiki();
            this.display();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Full resync")
          .setDisabled(!this.plugin.settings.authToken || this.plugin.isSyncInProgress())
          .onClick(async () => {
            await this.plugin.syncWiki({ force: true });
            this.display();
          }),
      );

    this.renderSyncProgress(containerEl);

    new Setting(containerEl)
      .setName("Auth status")
      .setDesc(this.plugin.settings.lastAuthStatus || "No auth attempt yet");

    new Setting(containerEl)
      .setName("Sync status")
      .setDesc(this.plugin.settings.lastSyncStatus || "No sync attempt yet");

    new Setting(containerEl)
      .setName("Sync folder")
      .setDesc("Folder where Stashwise Markdown files are written.")
      .addText((text) =>
        text.setValue(this.plugin.settings.syncFolder).onChange(async (value) => {
          this.plugin.settings.syncFolder = normalizePath(value.trim() || "Stashwise");
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Automatic sync on startup")
      .setDesc("Off by default. The first import only starts when you click Sync.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          this.plugin.settings.autoSyncConfiguredAt = new Date().toISOString();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Minutes between automatic syncs. Use 0 to disable.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        return text
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.syncIntervalMinutes = Number.isFinite(parsed)
              ? Math.max(0, parsed)
              : 0;
            this.plugin.settings.autoSyncConfiguredAt = new Date().toISOString();
            await this.plugin.saveSettings();
            this.plugin.resetSyncTimer();
          });
      });

    new Setting(containerEl)
      .setName("Include sources")
      .setDesc("Add source snippets and links to each topic note.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeSources).onChange(async (value) => {
          this.plugin.settings.includeSources = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Include Learn")
      .setDesc("Add generated Learn guides, battle transcripts, totems, and Learn build notes.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeLearn).onChange(async (value) => {
          this.plugin.settings.includeLearn = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Save images locally")
      .setDesc("Download source preview images into the vault so they keep working offline.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.saveImagesLocally).onChange(async (value) => {
          this.plugin.settings.saveImagesLocally = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Embed videos")
      .setDesc("Add iframe embeds to source notes when Stashwise has a supported video player URL.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.embedVideos).onChange(async (value) => {
          this.plugin.settings.embedVideos = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Media folder")
      .setDesc("Folder under the sync folder where local source images are written.")
      .addText((text) =>
        text.setValue(this.plugin.settings.mediaFolder).onChange(async (value) => {
          this.plugin.settings.mediaFolder = normalizePath(value.trim() || DEFAULT_SETTINGS.mediaFolder);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Image max width")
      .setDesc("Downloaded Stashwise media is requested as compressed JPEG up to this width.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "320";
        text.inputEl.max = "4096";
        return text
          .setValue(String(this.plugin.settings.imageMaxWidth))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.imageMaxWidth = Number.isFinite(parsed)
              ? Math.min(4096, Math.max(320, Math.round(parsed)))
              : DEFAULT_SETTINGS.imageMaxWidth;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("JPEG quality")
      .setDesc("Quality for compressed local image copies. Higher means larger files.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "30";
        text.inputEl.max = "95";
        return text
          .setValue(String(this.plugin.settings.imageJpegQuality))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.imageJpegQuality = Number.isFinite(parsed)
              ? Math.min(95, Math.max(30, Math.round(parsed)))
              : DEFAULT_SETTINGS.imageJpegQuality;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Include claims")
      .setDesc("Add Stashwise extracted claims and open contradictions to topic notes.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeClaims).onChange(async (value) => {
          this.plugin.settings.includeClaims = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Write graph index")
      .setDesc("Create Stashwise/Graph.md with cross-topic relationships.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.writeGraphIndex).onChange(async (value) => {
          this.plugin.settings.writeGraphIndex = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Clean up removed topics")
      .setDesc("Move local Stashwise topic notes to trash when they are no longer returned by Stashwise.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.deleteMissing).onChange(async (value) => {
          this.plugin.settings.deleteMissing = value;
          await this.plugin.saveSettings();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Clean once")
          .setDisabled(!this.plugin.settings.authToken || this.plugin.isSyncInProgress())
          .onClick(async () => {
            await this.plugin.syncWiki({ cleanupMissing: true });
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("Override for local backend testing.")
      .addText((text) =>
        text.setValue(this.plugin.settings.apiBaseUrl).onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value.trim() || DEFAULT_SETTINGS.apiBaseUrl;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Web base URL")
      .setDesc("Override for local auth testing.")
      .addText((text) =>
        text.setValue(this.plugin.settings.webBaseUrl).onChange(async (value) => {
          this.plugin.settings.webBaseUrl = value.trim() || DEFAULT_SETTINGS.webBaseUrl;
          await this.plugin.saveSettings();
        }),
      );
  }

  private renderSyncProgress(containerEl: HTMLElement): void {
    const progress = this.plugin.getSyncProgress();
    const shouldRender =
      progress.active ||
      progress.phase === "Sync complete" ||
      progress.phase === "Sync failed";
    if (!shouldRender) {
      return;
    }

    const percent = progressPercent(progress);
    const wrapper = containerEl.createDiv({ cls: "stashwise-sync-progress" });
    const header = wrapper.createDiv({ cls: "stashwise-sync-progress__header" });
    header.createSpan({ text: progress.phase });
    header.createSpan({
      text: progress.total > 0 ? `${Math.round(percent)}%` : progress.active ? "Working" : "",
    });

    const bar = wrapper.createDiv({ cls: "stashwise-sync-progress__bar" });
    bar.setAttr("role", "progressbar");
    bar.setAttr("aria-valuemin", "0");
    bar.setAttr("aria-valuemax", "100");
    bar.setAttr("aria-valuenow", String(Math.round(percent)));
    const fill = bar.createDiv({ cls: "stashwise-sync-progress__fill" });
    fill.setAttr("style", `width: ${percent}%;`);

    wrapper.createDiv({
      cls: "stashwise-sync-progress__meta",
      text: formatProgressMeta(progress),
    });
    if (progress.detail) {
      wrapper.createDiv({
        cls: "stashwise-sync-progress__detail",
        text: progress.detail,
      });
    }
  }
}

function deviceLabel(): string {
  const device = Platform.isMobile ? "mobile" : "desktop";
  return `Stashwise Obsidian on ${device}`;
}

function sourceTitle(source: MentionSource): string {
  return (source.title || source.source_url || "Untitled source")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceUpdatedAt(source: MentionSource): string {
  return source.content_updated_at || "";
}

function mediaKey(contentId: string, sourceUrl: string): string {
  return `${contentId}::${sourceUrl}`;
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return null;
}

function imageExtension(contentType: string, url: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  if (type === "image/heic") return "heic";
  try {
    const path = new URL(url).pathname.toLowerCase();
    const match = path.match(/\.([a-z0-9]{2,5})$/);
    if (match && ["jpg", "jpeg", "png", "webp", "gif", "heic"].includes(match[1])) {
      return match[1] === "jpeg" ? "jpg" : match[1];
    }
  } catch {
    // Use the portable default below.
  }
  return "jpg";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyExistsError(error: unknown): boolean {
  return /already exists|exists already|file exists/i.test(errorMessage(error));
}

function frontmatterValue(markdown: string, key: string): string | null {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) {
    return null;
  }
  const value = match[1].trim();
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.replace(/^["']|["']$/g, "");
  }
}

function formatLastSync(value: string | null): string {
  if (!value) {
    return "No sync yet";
  }
  return `Last sync: ${formatLocalDateTime(value)}`;
}

function formatLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

  if (date.toDateString() === now.toDateString()) {
    return `Today at ${time}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday at ${time}`;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function progressPercent(progress: SyncProgressState): number {
  if (!Number.isFinite(progress.total) || progress.total <= 0) {
    return progress.active ? 5 : 0;
  }
  return Math.min(100, Math.max(0, (progress.current / progress.total) * 100));
}

function formatProgressMeta(progress: SyncProgressState): string {
  const parts: string[] = [];
  if (progress.total > 0 && progress.unit !== "sync") {
    parts.push(
      `${progress.current.toLocaleString()} of ${progress.total.toLocaleString()} ${progress.unit}`,
    );
  }

  if (progress.active) {
    const remaining = estimateRemaining(progress);
    if (remaining !== null) {
      parts.push(`about ${formatDuration(remaining)} left`);
    }
    if (progress.startedAt > 0) {
      parts.push(`${formatDuration(Date.now() - progress.startedAt)} elapsed`);
    }
  } else if (progress.updatedAt > 0) {
    parts.push(`Finished ${formatLocalDateTime(new Date(progress.updatedAt).toISOString())}`);
  }

  return parts.join(" - ") || "Preparing sync.";
}

function estimateRemaining(progress: SyncProgressState): number | null {
  if (
    progress.current <= 0 ||
    progress.total <= 0 ||
    progress.current >= progress.total ||
    progress.phaseStartedAt <= 0
  ) {
    return null;
  }

  const elapsed = Date.now() - progress.phaseStartedAt;
  if (elapsed <= 0) {
    return null;
  }

  const perItem = elapsed / progress.current;
  return Math.max(0, perItem * (progress.total - progress.current));
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
