export interface DeviceCodeStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
}

export interface DeviceCodePollResponse {
  status: "pending" | "authorized" | "expired";
  token?: string;
  user?: MeResponse;
}

export interface MeResponse {
  id: string;
  email: string | null;
  display_name: string | null;
  subscription_tier: string;
}

export interface WikiPageListItem {
  entity_id: string;
  name: string;
  category: string;
  canonical_form: string | null;
  synthesized_summary: string | null;
  mention_count: number;
  updated_at: string;
}

export interface WikiPagesListResponse {
  items: WikiPageListItem[];
  total: number;
}

export interface MentionSource {
  content_id: string;
  title: string | null;
  source_url: string | null;
  thumbnail_url: string | null;
  thumbnail_download_url: string | null;
  source_platform: string | null;
  context_snippet: string | null;
  confidence: number;
  summary: string | null;
  content_type: string | null;
  tags: string[];
  takeaways: Array<Record<string, unknown>>;
  guide: string | null;
  guide_steps: Array<Record<string, unknown>>;
  images: string[];
  image_download_urls: string[];
  has_video: boolean;
  video_duration_seconds: number | null;
  video_embed_url: string | null;
  content_updated_at: string | null;
  useful_links: Array<Record<string, unknown>>;
  personal_notes: string | null;
}

export interface RelatedEntity {
  entity_id: string;
  name: string;
  category: string;
  relationship_type: string;
  strength: number;
}

export interface WikiClaimItem {
  id: string;
  claim: string;
  status: string;
  supporting_snippet: string | null;
  source_title: string | null;
  source_url: string | null;
  created_at: string;
  rejected_at: string | null;
}

export interface WikiContradictionItem {
  id: string;
  claim_a: string;
  claim_b: string;
  rationale: string | null;
  created_at: string;
  claim_a_supporting_snippet: string | null;
  claim_a_source_title: string | null;
  claim_a_source_url: string | null;
  claim_b_supporting_snippet: string | null;
  claim_b_source_title: string | null;
  claim_b_source_url: string | null;
}

export interface WikiPageDetailResponse {
  entity_id: string;
  name: string;
  category: string;
  canonical_form: string | null;
  synthesized_summary: string | null;
  mention_count: number;
  sources: MentionSource[];
  related: RelatedEntity[];
  claims: WikiClaimItem[];
  contradictions: WikiContradictionItem[];
  updated_at: string;
}

export interface GraphNode {
  id: string;
  label: string;
  category: string;
  mention_count: number;
}

export interface GraphEdge {
  a: string;
  b: string;
  type: string;
  strength: number;
}

export interface WikiGraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LearnReading {
  title: string;
  platform: string;
  url?: string | null;
}

export interface LearnDefinition {
  term: string;
  explanation: string;
}

export interface LearnSourceTakeaway {
  title: string;
  takeaway: string;
}

export interface LearnLibrarySource {
  id: string;
  title: string;
  platform: string;
  url?: string | null;
}

export interface LearnResearchSource {
  title: string;
  url?: string | null;
  source_type: string;
  snippet: string;
  why_used: string;
}

export interface LearnSession {
  num: number;
  duration_label: string;
  title: string;
  what_youll_explore: string;
  lesson: string;
  key_definitions: LearnDefinition[];
  source_takeaways: LearnSourceTakeaway[];
  how_to_use_this: string[];
  readings: LearnReading[];
  task: string;
  hint: string;
  check_yourself: string;
  commands: string[];
  linked_concepts: string[];
  checklist: string[];
  checkpoint: string;
}

export interface LearnConceptNode {
  id: string;
  label: string;
  summary: string;
  kind: string;
}

export interface LearnConceptEdge {
  from: string;
  to: string;
  label?: string | null;
  kind?: string | null;
}

export interface LearnConceptMap {
  nodes: LearnConceptNode[];
  edges: LearnConceptEdge[];
  version: number;
}

export interface LearnMasteryCardSection {
  label: string;
  content: string;
  kind: string;
  items: string[];
  code: string;
  expected_result: string;
}

export interface LearnCardLinkedConcept {
  entity_id: string;
  name: string;
  summary: string;
  relationship: string;
}

export interface LearnCardSupportingResource {
  content_id: string;
  title: string;
  platform: string;
  url?: string | null;
  why_it_supports: string;
}

export interface LearnMasteryCard {
  id: string;
  title: string;
  angle_id?: string;
  angle_label?: string;
  angle_focus?: string;
  sections?: LearnMasteryCardSection[];
  study_prompt?: string;
  linked_concepts?: LearnCardLinkedConcept[];
  supporting_resources?: LearnCardSupportingResource[];
  plain_explanation?: string;
  source_grounding?: string;
  blind_spot?: string;
  example_use?: string;
  feynman_prompt?: string;
}

export interface LearnBattleScenario {
  client_role: string;
  challenge: string;
  constraints: string[];
  win_condition: string;
}

export interface LearnBattleRun {
  id: string;
  guide_id: string;
  chat_session_id: string;
  status: "not_started" | "in_progress" | "cleared";
  turn_count: number;
  challenge_turns_survived: number;
  laws_applied: string[];
  named_tradeoffs: boolean;
  measurable_action_chain: boolean;
  contradiction_free: boolean;
  transcript_summary: string;
  created_at: string;
  updated_at: string;
}

export interface LearnBattleQuestion {
  question_id: string;
  card_id: string;
  angle_label: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  allow_free_text: boolean;
}

export interface LearnTopicChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  battle_question?: LearnBattleQuestion | null;
  message_options?: Record<string, unknown> | null;
  learn_build_patch?: Record<string, unknown> | null;
}

export interface WorkflowOutput {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  topic_ids: string[];
  chat_session_id?: string | null;
  content?: Record<string, unknown> | null;
  content_markdown?: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface LearnGuide {
  id: string;
  wiki_entity_id: string;
  title: string;
  subtitle: string;
  rising: boolean;
  why_this_matters: string;
  topic_chips: string[];
  source_titles: LearnReading[];
  library_sources: LearnLibrarySource[];
  research_sources: LearnResearchSource[];
  session_count: number;
  total_duration_label: string;
  state: "default" | "locked";
  current_session: number;
  sessions: LearnSession[];
  checked_items: Record<string, boolean>;
  session_plan_opened: boolean;
  concept_map: LearnConceptMap;
  concept_canvas: Record<string, unknown>[];
  source: "auto" | "manual";
  mastery_cards: LearnMasteryCard[];
  battle_scenario: LearnBattleScenario;
  battle_status: "not_started" | "in_progress" | "cleared";
  totem_sentences: string[];
}

export interface LearnSyncManifestItem {
  guide_id: string;
  wiki_entity_id: string;
  title: string;
  source: "auto" | "manual";
  status: string;
  battle_status: "not_started" | "in_progress" | "cleared";
  build_output_id?: string | null;
  sync_updated_at: string;
}

export interface LearnSyncManifestResponse {
  items: LearnSyncManifestItem[];
  total: number;
}

export interface LearnSyncGuideDetailResponse {
  guide: LearnGuide;
  battle: {
    guide_id: string;
    battle_status: "not_started" | "in_progress" | "cleared";
    scenario: LearnBattleScenario;
    run?: LearnBattleRun | null;
    messages: LearnTopicChatMessage[];
    totem_sentences: string[];
  };
  chat_session_id?: string | null;
  chat_title?: string | null;
  phase: "battle" | "totems" | "build";
  messages: LearnTopicChatMessage[];
  build_output?: WorkflowOutput | null;
  sync_updated_at: string;
}

export interface LearnGeneratorWikiEntity {
  id: string;
  name: string;
  category?: string | null;
  source_count: number;
}

export interface LearnGeneratorTopic {
  id: string;
  label: string;
  category?: string | null;
  entity_id?: string | null;
  kind: "topic" | "news_topic";
}

export interface LearnPickableContent {
  id: string;
  title: string;
  source_url: string;
  source_platform: string;
}

export interface LearnGeneratorContextResponse {
  wiki_entities: LearnGeneratorWikiEntity[];
  saved_topics: LearnGeneratorTopic[];
  content_items: LearnPickableContent[];
  weekly_learn_remaining: number;
  max_picks_per_request: number;
}

export interface KnownPage {
  name: string;
  path: string;
  updatedAt: string;
}

export interface KnownSource {
  title: string;
  path: string;
  updatedAt: string;
}

export interface KnownMedia {
  sourceUrl: string;
  downloadUrl: string;
  path: string;
  downloadedAt: string;
  byteLength: number;
}

export interface KnownLearnGuide {
  title: string;
  path: string;
  updatedAt: string;
  buildOutputId: string | null;
}

export interface KnownLearnBuild {
  title: string;
  path: string;
  updatedAt: string;
}

export interface StashwiseSettings {
  apiBaseUrl: string;
  webBaseUrl: string;
  authToken: string;
  userLabel: string;
  syncFolder: string;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  autoSyncConfiguredAt: string | null;
  includeSources: boolean;
  includeClaims: boolean;
  includeLearn: boolean;
  writeGraphIndex: boolean;
  deleteMissing: boolean;
  saveImagesLocally: boolean;
  embedVideos: boolean;
  mediaFolder: string;
  imageMaxWidth: number;
  imageJpegQuality: number;
  lastSyncAt: string | null;
  lastAuthStatus: string | null;
  lastSyncStatus: string | null;
  knownPages: Record<string, KnownPage>;
  knownSources: Record<string, KnownSource>;
  knownMedia: Record<string, KnownMedia>;
  knownLearnGuides: Record<string, KnownLearnGuide>;
  knownLearnBuilds: Record<string, KnownLearnBuild>;
}

export interface LinkTarget {
  entityId: string;
  name: string;
  path: string;
}

export interface SourceLinkTarget {
  contentId: string;
  title: string;
  path: string;
}

export interface SyncSummary {
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  sourcesCreated: number;
  sourcesUpdated: number;
  sourcesSkipped: number;
  mediaDownloaded: number;
  mediaSkipped: number;
  mediaFailed: number;
  learnGuidesCreated: number;
  learnGuidesUpdated: number;
  learnGuidesSkipped: number;
  learnBuildsCreated: number;
  learnBuildsUpdated: number;
  learnBuildsSkipped: number;
  learnTotal: number;
  total: number;
}

export const DEFAULT_SETTINGS: StashwiseSettings = {
  apiBaseUrl: "https://stashwise-api.fly.dev/api/v1",
  webBaseUrl: "https://stashwise.co",
  authToken: "",
  userLabel: "",
  syncFolder: "Stashwise",
  syncOnStartup: false,
  syncIntervalMinutes: 0,
  autoSyncConfiguredAt: null,
  includeSources: true,
  includeClaims: true,
  includeLearn: true,
  writeGraphIndex: true,
  deleteMissing: false,
  saveImagesLocally: true,
  embedVideos: true,
  mediaFolder: "Assets",
  imageMaxWidth: 1600,
  imageJpegQuality: 82,
  lastSyncAt: null,
  lastAuthStatus: null,
  lastSyncStatus: null,
  knownPages: {},
  knownSources: {},
  knownMedia: {},
  knownLearnGuides: {},
  knownLearnBuilds: {},
};
