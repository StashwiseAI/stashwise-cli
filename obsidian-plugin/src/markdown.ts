import type {
  LearnGeneratorContextResponse,
  LearnMasteryCard,
  LearnSession,
  LearnSyncGuideDetailResponse,
  LearnSyncManifestItem,
  LinkTarget,
  MentionSource,
  SourceLinkTarget,
  WorkflowOutput,
  WikiClaimItem,
  WikiGraphResponse,
  WikiPageDetailResponse,
  WikiPageListItem,
} from "./types";

export interface RenderMediaContext {
  mediaByUrl: Map<string, string>;
  sourceLinksByContentId: Map<string, SourceLinkTarget>;
  embedVideos: boolean;
}

export interface LearnGuideLinkTarget {
  guideId: string;
  title: string;
  path: string;
}

export interface LearnBuildLinkTarget {
  outputId: string;
  title: string;
  path: string;
}

export interface RenderLearnContext {
  topicLinksByEntityId: Map<string, LinkTarget>;
  sourceLinksByContentId: Map<string, SourceLinkTarget>;
  buildLink: LearnBuildLinkTarget | null;
  syncedAt: string;
}

export function sanitizeFileName(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Untitled").slice(0, 120);
}

export function renderWikiPage(
  page: WikiPageDetailResponse,
  linksByEntityId: Map<string, LinkTarget>,
  options: {
    includeSources: boolean;
    includeClaims: boolean;
    media: RenderMediaContext;
  },
): string {
  const lines: string[] = [
    "---",
    `stashwise_id: ${yamlString(page.entity_id)}`,
    "stashwise_type: wiki_page",
    `stashwise_updated_at: ${yamlString(page.updated_at)}`,
    `title: ${yamlString(page.name)}`,
    `aliases: [${yamlString(page.name)}]`,
    `category: ${yamlString(page.category)}`,
    `canonical_form: ${yamlString(page.canonical_form ?? "")}`,
    `mention_count: ${page.mention_count}`,
    "source: stashwise",
    "---",
    "",
    `# ${page.name}`,
    "",
  ];

  if (page.synthesized_summary?.trim()) {
    lines.push("## Stashwise Summary", "", page.synthesized_summary.trim(), "");
  } else {
    lines.push("## Stashwise Summary", "", "_No synthesized summary yet._", "");
  }

  if (page.related.length > 0) {
    lines.push("## Related", "");
    for (const related of page.related) {
      const target = linksByEntityId.get(related.entity_id);
      const link = target ? wikilink(target.path, related.name) : `[[${escapeLink(related.name)}]]`;
      lines.push(
        `- ${link} - ${related.relationship_type} (${percent(related.strength)})`,
      );
    }
    lines.push("");
  }

  if (options.includeClaims && page.claims.length > 0) {
    lines.push("## Claims", "");
    for (const claim of page.claims) {
      lines.push(`- ${cleanInline(claim.claim)}${claim.status === "rejected" ? " _(rejected)_" : ""}`);
      const source = sourceLine(claim);
      if (source) {
        lines.push(`  Source: ${source}`);
      }
      if (claim.supporting_snippet) {
        lines.push(`  Evidence: ${cleanInline(claim.supporting_snippet)}`);
      }
    }
    lines.push("");
  }

  if (page.contradictions.length > 0) {
    lines.push("## Open Contradictions", "");
    for (const item of page.contradictions) {
      lines.push(`- ${cleanInline(item.claim_a)} / ${cleanInline(item.claim_b)}`);
      if (item.rationale) {
        lines.push(`  Rationale: ${cleanInline(item.rationale)}`);
      }
    }
    lines.push("");
  }

  if (options.includeSources && page.sources.length > 0) {
    lines.push("## Sources", "");
    for (const source of page.sources) {
      lines.push(renderTopicSource(source, options.media), "");
    }
  }

  lines.push("## Stashwise", "", `Synced from Stashwise at ${localDateTime(new Date())}.`, "");
  return lines.join("\n");
}

export function renderSourceNote(
  source: MentionSource,
  backlinks: LinkTarget[],
  media: RenderMediaContext,
  syncedAt: string,
): string {
  const title = sourceTitle(source);
  const sourceUpdatedAt = source.content_updated_at ?? syncedAt;
  const localImages = sourceLocalImages(source, media.mediaByUrl);
  const lines: string[] = [
    "---",
    `stashwise_id: ${yamlString(source.content_id)}`,
    "stashwise_type: source",
    `stashwise_updated_at: ${yamlString(sourceUpdatedAt)}`,
    `title: ${yamlString(title)}`,
    `source_url: ${yamlString(source.source_url ?? "")}`,
    `source_platform: ${yamlString(source.source_platform ?? "")}`,
    `content_type: ${yamlString(source.content_type ?? "")}`,
    `tags: [${(source.tags ?? []).map(yamlString).join(", ")}]`,
    "source: stashwise",
    "---",
    "",
    `# ${title}`,
    "",
  ];

  if (source.source_url) {
    lines.push(`[Open original](${source.source_url})`, "");
  }

  if (hasSourceMedia(source, localImages, media.embedVideos)) {
    lines.push("## Media", "");
    if (media.embedVideos && source.video_embed_url) {
      lines.push(
        `<iframe src="${htmlAttribute(source.video_embed_url)}" width="100%" height="520" loading="lazy" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>`,
        "",
      );
    }
    if (localImages.length > 0) {
      for (const imagePath of localImages) {
        lines.push(embedWikilink(imagePath));
      }
      lines.push("");
    } else if (source.thumbnail_url) {
      lines.push(markdownImage(title, source.thumbnail_url), "");
    }
  }

  if (source.summary?.trim()) {
    lines.push("## Summary", "", source.summary.trim(), "");
  }

  const takeaways = renderTakeaways(source.takeaways, Number.POSITIVE_INFINITY);
  if (takeaways.length > 0) {
    lines.push("## Key Takeaways", "", ...takeaways, "");
  }

  const steps = renderGuideSteps(source.guide_steps);
  if (steps.length > 0) {
    lines.push("## Step-by-Step", "", ...steps, "");
  } else if (source.guide?.trim()) {
    lines.push("## Guide", "", source.guide.trim(), "");
  }

  if (source.personal_notes?.trim()) {
    lines.push("## Personal Notes", "", source.personal_notes.trim(), "");
  }

  const usefulLinks = renderUsefulLinks(source.useful_links);
  if (usefulLinks.length > 0) {
    lines.push("## Useful Links", "", ...usefulLinks, "");
  }

  if (backlinks.length > 0) {
    lines.push("## Topic Backlinks", "");
    for (const backlink of backlinks) {
      lines.push(`- ${wikilink(backlink.path, backlink.name)}`);
    }
    lines.push("");
  }

  lines.push("## Stashwise", "", `Synced from Stashwise at ${localDateTime(new Date(syncedAt))}.`, "");
  return lines.join("\n");
}

export function renderHome(
  pages: WikiPageListItem[],
  linksByEntityId: Map<string, LinkTarget>,
  syncedAt: string,
  learn?: {
    guideCount: number;
    homePath: string;
  },
): string {
  const byCategory = new Map<string, WikiPageListItem[]>();
  for (const page of pages) {
    const group = byCategory.get(page.category) ?? [];
    group.push(page);
    byCategory.set(page.category, group);
  }

  const lines: string[] = [
    "---",
    "stashwise_type: index",
    `stashwise_updated_at: ${yamlString(syncedAt)}`,
    "source: stashwise",
    "---",
    "",
    "# Stashwise",
    "",
    `Last synced: ${localDateTime(new Date(syncedAt))}`,
    "",
    "## Topics",
    "",
  ];

  const categories = [...byCategory.keys()].sort((a, b) => a.localeCompare(b));
  for (const category of categories) {
    lines.push(`### ${category}`, "");
    const items = [...(byCategory.get(category) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const page of items) {
      const target = linksByEntityId.get(page.entity_id);
      const link = target ? wikilink(target.path, page.name) : `[[${escapeLink(page.name)}]]`;
      lines.push(`- ${link} - ${page.mention_count} mentions`);
    }
    lines.push("");
  }

  if (learn && learn.guideCount > 0) {
    lines.push(
      "## Learn",
      "",
      `- ${wikilink(learn.homePath, "Learn")} - ${learn.guideCount} generated guides`,
      "",
    );
  }

  return lines.join("\n");
}

export function renderGraphIndex(
  graph: WikiGraphResponse,
  linksByEntityId: Map<string, LinkTarget>,
  syncedAt: string,
): string {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const lines: string[] = [
    "---",
    "stashwise_type: graph_index",
    `stashwise_updated_at: ${yamlString(syncedAt)}`,
    "source: stashwise",
    "---",
    "",
    "# Stashwise Graph",
    "",
    "## Relationships",
    "",
  ];

  for (const edge of graph.edges) {
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);
    if (!a || !b) {
      continue;
    }
    const linkA = linksByEntityId.get(a.id)
      ? wikilink(linksByEntityId.get(a.id)!.path, a.label)
      : `[[${escapeLink(a.label)}]]`;
    const linkB = linksByEntityId.get(b.id)
      ? wikilink(linksByEntityId.get(b.id)!.path, b.label)
      : `[[${escapeLink(b.label)}]]`;
    lines.push(`- ${linkA} -> ${linkB} - ${edge.type} (${percent(edge.strength)})`);
  }

  if (graph.edges.length === 0) {
    lines.push("_No relationships synced yet._");
  }

  lines.push("");
  return lines.join("\n");
}

export function renderLearnHome(
  items: LearnSyncManifestItem[],
  linksByGuideId: Map<string, LearnGuideLinkTarget>,
  generatorContext: LearnGeneratorContextResponse | null,
  syncedAt: string,
): string {
  const lines: string[] = [
    "---",
    "stashwise_type: learn_index",
    `stashwise_updated_at: ${yamlString(syncedAt)}`,
    "source: stashwise",
    "---",
    "",
    "# Stashwise Learn",
    "",
    `Last synced: ${localDateTime(new Date(syncedAt))}`,
    "",
    "## Guides",
    "",
  ];

  if (items.length === 0) {
    lines.push("_No generated Learn guides synced yet._", "");
  } else {
    for (const item of items) {
      const target = linksByGuideId.get(item.guide_id);
      const link = target
        ? wikilink(target.path, item.title)
        : `[[${escapeLink(item.title)}]]`;
      const badges = [
        item.source === "manual" ? "self generated" : "auto",
        item.battle_status.replace(/_/g, " "),
        item.build_output_id ? "build ready" : "",
      ].filter(Boolean);
      lines.push(`- ${link} - ${badges.join(", ")}`);
    }
    lines.push("");
  }

  if (generatorContext) {
    lines.push("## Generator Inventory", "");
    lines.push(
      `- Weekly Learn generations remaining: ${generatorContext.weekly_learn_remaining}`,
      `- Max picks per request: ${generatorContext.max_picks_per_request}`,
      `- Wiki concepts available: ${generatorContext.wiki_entities.length}`,
      `- Saved topics available: ${generatorContext.saved_topics.length}`,
      `- Recent library items available: ${generatorContext.content_items.length}`,
      "",
    );

    const topics = generatorContext.saved_topics.slice(0, 20);
    if (topics.length > 0) {
      lines.push("### Saved Topics", "");
      for (const topic of topics) {
        lines.push(`- ${cleanInline(topic.label)}${topic.category ? ` (${topic.category})` : ""}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function renderLearnGuideNote(
  detail: LearnSyncGuideDetailResponse,
  context: RenderLearnContext,
): string {
  const guide = detail.guide;
  const topicLink = context.topicLinksByEntityId.get(guide.wiki_entity_id);
  const lines: string[] = [
    "---",
    `stashwise_id: ${yamlString(guide.id)}`,
    "stashwise_type: learn_guide",
    `stashwise_updated_at: ${yamlString(detail.sync_updated_at)}`,
    `title: ${yamlString(guide.title)}`,
    `aliases: [${yamlString(guide.title)}]`,
    `wiki_entity_id: ${yamlString(guide.wiki_entity_id)}`,
    `learn_source: ${yamlString(guide.source)}`,
    `learn_status: ${yamlString(guide.battle_status)}`,
    "source: stashwise",
    "---",
    "",
    `# ${guide.title}`,
    "",
  ];

  if (guide.subtitle) {
    lines.push(guide.subtitle, "");
  }
  if (guide.why_this_matters) {
    lines.push("## Why This Matters", "", guide.why_this_matters.trim(), "");
  }

  lines.push("## Overview", "");
  if (topicLink) {
    lines.push(`- Topic: ${wikilink(topicLink.path, topicLink.name)}`);
  }
  lines.push(
    `- Duration: ${guide.total_duration_label || "unspecified"}`,
    `- Sessions: ${guide.session_count}`,
    `- Current session: ${guide.current_session}`,
    `- Source: ${guide.source === "manual" ? "self generated" : "auto generated"}`,
    `- Battle: ${detail.battle.battle_status.replace(/_/g, " ")}`,
  );
  if (context.buildLink) {
    lines.push(`- Build guide: ${wikilink(context.buildLink.path, context.buildLink.title)}`);
  }
  if (guide.topic_chips.length > 0) {
    lines.push(`- Tags: ${guide.topic_chips.map(cleanInline).join(", ")}`);
  }
  lines.push("");

  renderLearnSessions(lines, guide.sessions, guide.checked_items);
  renderMasteryCards(lines, guide.mastery_cards, guide.checked_items);
  renderConceptMap(lines, guide.concept_map);
  renderLearnBattle(lines, detail);
  renderLearnSources(lines, detail, context);

  lines.push("## Stashwise", "", `Synced from Stashwise at ${localDateTime(new Date(context.syncedAt))}.`, "");
  return lines.join("\n");
}

export function renderLearnBuildNote(
  output: WorkflowOutput,
  guideLink: LearnGuideLinkTarget | null,
  syncedAt: string,
): string {
  const lines: string[] = [
    "---",
    `stashwise_id: ${yamlString(output.id)}`,
    "stashwise_type: learn_build",
    `stashwise_updated_at: ${yamlString(output.updated_at)}`,
    `title: ${yamlString(output.title)}`,
    "source: stashwise",
    "---",
    "",
    `# ${output.title}`,
    "",
  ];

  if (guideLink) {
    lines.push(`Source Learn guide: ${wikilink(guideLink.path, guideLink.title)}`, "");
  }
  if (output.content_markdown?.trim()) {
    lines.push("## Build Guide", "", output.content_markdown.trim(), "");
  }

  const sections = learnBuildSections(output.content);
  if (sections.length > 0) {
    const completed = new Set(stringArrayValue(output.content?.completed_step_ids));
    lines.push("## Guided Progress", "");
    for (const section of sections) {
      lines.push(`### ${section.title}`, "");
      for (const step of section.steps) {
        const done = completed.has(step.step_id) ? "x" : " ";
        lines.push(`- [${done}] ${cleanInline(step.title || "Setup step")}`);
        if (step.instruction) lines.push(`  ${step.instruction}`);
        if (step.expected_result) lines.push(`  Expected: ${step.expected_result}`);
        if (step.troubleshooting) lines.push(`  Troubleshooting: ${step.troubleshooting}`);
      }
      lines.push("");
    }
  }

  lines.push("## Stashwise", "", `Synced from Stashwise at ${localDateTime(new Date(syncedAt))}.`, "");
  return lines.join("\n");
}

export function stripMarkdownExtension(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function renderLearnSessions(
  lines: string[],
  sessions: LearnSession[],
  checkedItems: Record<string, boolean>,
): void {
  if (sessions.length === 0) {
    return;
  }
  lines.push("## Learning Process", "");
  for (const session of sessions) {
    lines.push(`### ${session.num}. ${session.title}`, "");
    if (session.duration_label) lines.push(`Duration: ${session.duration_label}`, "");
    if (session.what_youll_explore) {
      lines.push(session.what_youll_explore.trim(), "");
    }
    if (session.lesson) {
      lines.push("#### Lesson", "", session.lesson.trim(), "");
    }
    if (session.key_definitions.length > 0) {
      lines.push("#### Key Definitions", "");
      for (const definition of session.key_definitions) {
        lines.push(`- **${cleanInline(definition.term)}:** ${cleanInline(definition.explanation)}`);
      }
      lines.push("");
    }
    if (session.source_takeaways.length > 0) {
      lines.push("#### Source Takeaways", "");
      for (const takeaway of session.source_takeaways) {
        lines.push(`- **${cleanInline(takeaway.title)}:** ${cleanInline(takeaway.takeaway)}`);
      }
      lines.push("");
    }
    if (session.how_to_use_this.length > 0) {
      lines.push("#### How To Use This", "", ...session.how_to_use_this.map((item) => `- ${cleanInline(item)}`), "");
    }
    if (session.readings.length > 0) {
      lines.push("#### Readings", "");
      for (const reading of session.readings) {
        lines.push(
          reading.url
            ? `- [${cleanInline(reading.title)}](${reading.url}) (${reading.platform})`
            : `- ${cleanInline(reading.title)} (${reading.platform})`,
        );
      }
      lines.push("");
    }
    if (session.commands.length > 0) {
      lines.push("#### Commands", "", ...session.commands.map((cmd) => `\`${cmd}\``), "");
    }
    if (session.checklist.length > 0) {
      lines.push("#### Checklist", "");
      session.checklist.forEach((item, index) => {
        const done = checkedItems[`${session.num}:${index}`] ? "x" : " ";
        lines.push(`- [${done}] ${cleanInline(item)}`);
      });
      lines.push("");
    }
    if (session.task) lines.push("#### Task", "", session.task.trim(), "");
    if (session.hint) lines.push("#### Hint", "", session.hint.trim(), "");
    if (session.check_yourself) {
      lines.push("#### Check Yourself", "", session.check_yourself.trim(), "");
    }
    if (session.linked_concepts.length > 0) {
      lines.push(`Linked concepts: ${session.linked_concepts.map(cleanInline).join(", ")}`, "");
    }
  }
}

function renderMasteryCards(
  lines: string[],
  cards: LearnMasteryCard[],
  checkedItems: Record<string, boolean>,
): void {
  if (cards.length === 0) {
    return;
  }
  lines.push("## Mastery Cards", "");
  for (const card of cards) {
    const done = checkedItems[`law:${card.id}`] ? "x" : " ";
    lines.push(`### [${done}] ${card.title}`, "");
    if (card.angle_label || card.angle_focus) {
      lines.push([card.angle_label, card.angle_focus].filter(Boolean).join(" - "), "");
    }
    for (const section of card.sections ?? []) {
      if (section.label) lines.push(`#### ${section.label}`, "");
      if (section.content) lines.push(section.content.trim(), "");
      if (section.items.length > 0) {
        lines.push(...section.items.map((item) => `- ${cleanInline(item)}`), "");
      }
      if (section.code) lines.push("```", section.code, "```", "");
      if (section.expected_result) {
        lines.push(`Expected result: ${section.expected_result}`, "");
      }
    }
    if (card.study_prompt) lines.push(`Study prompt: ${card.study_prompt}`, "");
    if (card.feynman_prompt) lines.push(`Feynman prompt: ${card.feynman_prompt}`, "");
  }
}

function renderConceptMap(lines: string[], conceptMap: { nodes?: unknown; edges?: unknown }): void {
  const nodes = Array.isArray(conceptMap.nodes) ? conceptMap.nodes : [];
  const edges = Array.isArray(conceptMap.edges) ? conceptMap.edges : [];
  if (nodes.length === 0 && edges.length === 0) {
    return;
  }
  lines.push("## Concept Map", "");
  if (nodes.length > 0) {
    lines.push("### Nodes", "");
    for (const node of nodes) {
      if (!isRecord(node)) continue;
      lines.push(`- **${cleanInline(stringValue(node.label) ?? "Concept")}** (${stringValue(node.kind) ?? "concept"})`);
      const summary = stringValue(node.summary);
      if (summary) lines.push(`  ${summary}`);
    }
    lines.push("");
  }
  if (edges.length > 0) {
    lines.push("### Edges", "");
    for (const edge of edges) {
      if (!isRecord(edge)) continue;
      const from = stringValue(edge.from) ?? "";
      const to = stringValue(edge.to) ?? "";
      if (!from || !to) continue;
      lines.push(`- ${from} -> ${to}${edge.kind ? ` (${String(edge.kind)})` : ""}`);
    }
    lines.push("");
  }
}

function renderLearnBattle(lines: string[], detail: LearnSyncGuideDetailResponse): void {
  lines.push("## Battle And Totems", "");
  lines.push(`Status: ${detail.battle.battle_status.replace(/_/g, " ")}`, "");
  const scenario = detail.battle.scenario;
  if (scenario.challenge) lines.push(`Challenge: ${scenario.challenge}`, "");
  if (scenario.constraints.length > 0) {
    lines.push("Constraints", "", ...scenario.constraints.map((item) => `- ${cleanInline(item)}`), "");
  }
  if (detail.battle.run?.transcript_summary) {
    lines.push("### Transcript Summary", "", detail.battle.run.transcript_summary.trim(), "");
  }
  const totems = detail.battle.totem_sentences.length
    ? detail.battle.totem_sentences
    : detail.guide.totem_sentences;
  if (totems.length > 0) {
    lines.push("### Totems", "", ...totems.slice(0, 3).map((item) => `- ${cleanInline(item)}`), "");
  }
  if (detail.messages.length > 0) {
    lines.push("### Transcript", "");
    for (const message of detail.messages) {
      lines.push(`- **${message.role}:** ${cleanInline(message.content)}`);
      if (message.battle_question) {
        lines.push(`  Question: ${cleanInline(message.battle_question.prompt)}`);
      }
    }
    lines.push("");
  }
}

function renderLearnSources(
  lines: string[],
  detail: LearnSyncGuideDetailResponse,
  context: RenderLearnContext,
): void {
  const research = detail.guide.research_sources;
  const library = detail.guide.library_sources;
  if (research.length === 0 && library.length === 0 && detail.guide.source_titles.length === 0) {
    return;
  }
  lines.push("## Sources", "");
  if (detail.guide.source_titles.length > 0) {
    lines.push("### Cited In Guide", "");
    for (const source of detail.guide.source_titles) {
      lines.push(source.url ? `- [${cleanInline(source.title)}](${source.url})` : `- ${cleanInline(source.title)}`);
    }
    lines.push("");
  }
  if (research.length > 0) {
    lines.push("### Research Basis", "");
    for (const source of research) {
      const title = cleanInline(source.title || source.url || "Research source");
      lines.push(source.url ? `- [${title}](${source.url})` : `- ${title}`);
      if (source.why_used) lines.push(`  ${cleanInline(source.why_used)}`);
      if (source.snippet) lines.push(`  ${cleanInline(source.snippet)}`);
    }
    lines.push("");
  }
  if (library.length > 0) {
    lines.push("### Library Sources", "");
    for (const source of library) {
      const local = context.sourceLinksByContentId.get(source.id);
      const title = cleanInline(source.title || source.url || "Library source");
      const link = local
        ? wikilink(local.path, title)
        : source.url
          ? `[${title}](${source.url})`
          : title;
      lines.push(`- ${link} (${source.platform})`);
    }
    lines.push("");
  }
}

function learnBuildSections(content: Record<string, unknown> | null | undefined): Array<{
  title: string;
  steps: Array<{
    step_id: string;
    title: string;
    instruction: string;
    expected_result: string;
    troubleshooting: string;
  }>;
}> {
  const rawSections = Array.isArray(content?.guide_sections) ? content.guide_sections : [];
  const sections: Array<{
    title: string;
    steps: Array<{
      step_id: string;
      title: string;
      instruction: string;
      expected_result: string;
      troubleshooting: string;
    }>;
  }> = [];
  for (const raw of rawSections) {
    if (!isRecord(raw)) continue;
    const steps: Array<{
      step_id: string;
      title: string;
      instruction: string;
      expected_result: string;
      troubleshooting: string;
    }> = [];
    const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
    for (const rawStep of rawSteps) {
      if (!isRecord(rawStep)) continue;
      steps.push({
        step_id: stringValue(rawStep.step_id) ?? "",
        title: stringValue(rawStep.title) ?? "Setup step",
        instruction: stringValue(rawStep.instruction) ?? "",
        expected_result: stringValue(rawStep.expected_result) ?? "",
        troubleshooting: stringValue(rawStep.troubleshooting) ?? "",
      });
    }
    sections.push({
      title: stringValue(raw.title) ?? "Setup",
      steps,
    });
  }
  return sections;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.trim())
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderTopicSource(source: MentionSource, media: RenderMediaContext): string {
  const title = sourceTitle(source);
  const sourceTarget = media.sourceLinksByContentId.get(source.content_id);
  const heading = sourceTarget
    ? `### ${wikilink(sourceTarget.path, title)}`
    : source.source_url
      ? `### [${title}](${source.source_url})`
      : `### ${title}`;
  const lines = [
    heading,
    `- Platform: ${source.source_platform || "unknown"}`,
    `- Confidence: ${percent(source.confidence)}`,
  ];
  if (source.source_url) {
    lines.push(`- Original: [${cleanInline(source.source_url)}](${source.source_url})`);
  }
  if (sourceTarget) {
    lines.push(`- Source note: ${wikilink(sourceTarget.path, title)}`);
  }
  if (source.context_snippet) {
    lines.push(`- Mention context: ${cleanInline(source.context_snippet)}`);
  }
  if (source.has_video && source.video_embed_url && sourceTarget) {
    lines.push(`- Video: embedded in ${wikilink(sourceTarget.path, title)}`);
  }

  const previewImage = firstSourceImagePath(source, media.mediaByUrl);
  if (previewImage) {
    lines.push("", embedWikilink(previewImage));
  } else if (source.thumbnail_url) {
    lines.push("", markdownImage(title, source.thumbnail_url));
  }

  if (source.summary?.trim()) {
    lines.push("", blockquote(truncateText(source.summary.trim(), 700)));
  }

  const takeaways = renderTakeaways(source.takeaways, 3);
  if (takeaways.length > 0) {
    lines.push("", "**Key takeaways**", ...takeaways);
  }

  if (source.personal_notes) {
    lines.push("", `**Personal note:** ${cleanInline(source.personal_notes)}`);
  }
  return lines.join("\n");
}

function renderTakeaways(items: Array<Record<string, unknown>> | undefined, limit: number): string[] {
  const lines: string[] = [];
  for (const item of items ?? []) {
    const text = stringValue(item.text);
    if (!text) {
      continue;
    }
    const timestamp = stringValue(item.timestamp);
    lines.push(`- ${timestamp ? `(${timestamp}) ` : ""}${cleanInline(text)}`);
    if (lines.length >= limit) {
      break;
    }
  }
  return lines;
}

function renderGuideSteps(items: Array<Record<string, unknown>> | undefined): string[] {
  const lines: string[] = [];
  let index = 1;
  for (const item of items ?? []) {
    const step = stringValue(item.step);
    const description = stringValue(item.description);
    if (!step && !description) {
      continue;
    }
    const timestamp = stringValue(item.timestamp);
    lines.push(`${index}. **${cleanInline(step || `Step ${index}`)}**${timestamp ? ` (${timestamp})` : ""}`);
    if (description) {
      lines.push(`   ${description.trim().replace(/\n+/g, "\n   ")}`);
    }
    index += 1;
  }
  return lines;
}

function renderUsefulLinks(items: Array<Record<string, unknown>> | undefined): string[] {
  const lines: string[] = [];
  for (const item of items ?? []) {
    const url = stringValue(item.url);
    if (!url) {
      continue;
    }
    const label = stringValue(item.label) || stringValue(item.title) || url;
    lines.push(`- [${cleanInline(label)}](${url})`);
  }
  return lines;
}

function sourceTitle(source: MentionSource): string {
  return cleanInline(source.title || source.source_url || "Untitled source");
}

function firstSourceImagePath(source: MentionSource, mediaByUrl: Map<string, string>): string | null {
  return sourceLocalImages(source, mediaByUrl)[0] ?? null;
}

function sourceLocalImages(source: MentionSource, mediaByUrl: Map<string, string>): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const url of sourceImageUrls(source)) {
    const path = mediaByUrl.get(url);
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function sourceImageUrls(source: MentionSource): string[] {
  const urls = [source.thumbnail_url, ...(source.images ?? [])].filter((url): url is string =>
    Boolean(url),
  );
  const seen = new Set<string>();
  return urls.filter((url) => {
    const key = url.trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasSourceMedia(
  source: MentionSource,
  localImages: string[],
  embedVideos: boolean,
): boolean {
  return (
    localImages.length > 0 ||
    Boolean(source.thumbnail_url) ||
    Boolean(embedVideos && source.video_embed_url)
  );
}

function wikilink(path: string, label: string): string {
  return `[[${escapeLink(stripMarkdownExtension(path))}|${escapeLink(label)}]]`;
}

function embedWikilink(path: string): string {
  return `![[${escapeLink(path)}]]`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function escapeLink(value: string): string {
  return value.replace(/\|/g, "-").replace(/\]\]/g, "]");
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function cleanInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trim()}...`;
}

function blockquote(value: string): string {
  return value
    .split(/\n+/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function markdownImage(title: string, url: string): string {
  return `![${cleanInline(title)}](${url.replace(/\)/g, "%29")})`;
}

function htmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function sourceLine(claim: WikiClaimItem): string | null {
  if (!claim.source_title && !claim.source_url) {
    return null;
  }
  const title = cleanInline(claim.source_title || claim.source_url || "Source");
  return claim.source_url ? `[${title}](${claim.source_url})` : title;
}

function localDateTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
