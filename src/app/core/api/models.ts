export interface JsonBlob {
  id: string;
  slug: string;
  content: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  isPublic: boolean;
}

/**
 * Metadata describing a blob that the server silently deleted to make room
 * for a new one under the auto-FIFO quota strategy. Kept off JsonBlob so the
 * shape of stored blobs stays clean.
 */
export interface AutoDeletedBlobInfo {
  id: string;
  slug: string;
  title?: string;
}

/**
 * The POST /api/blobs response: the newly-created blob, plus an optional
 * `autoDeleted` marker present only when the auto-FIFO quota strategy kicked
 * in and the server removed the caller's oldest blob.
 */
export type CreateBlobResponse = JsonBlob & { autoDeleted?: AutoDeletedBlobInfo };

export interface User {
  id: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
  createdAt: string;
  plan: 'free' | 'pro';
  preferences: UserPreferences;
}

export interface ThemeColorSet {
  selectionColor: string;
  matchingValueColor: string;
  ancestorColor: string;
  searchHighlightColor: string;
}

export interface TreeHighlightColors {
  dark: ThemeColorSet;
  light: ThemeColorSet;
}

export interface UserPreferences {
  theme: 'dark' | 'light' | 'system';
  editorFontSize: number;
  editorTabSize: 2 | 4;
  defaultTreeExpansionDepth: number;
  defaultRuleSetId?: string;
  editorWordWrap: boolean;
  layoutOrientation: 'horizontal' | 'vertical';
  treeFontSize: number;
  treeShowTypeLabels: boolean;
  treeShowDateAnnotations: boolean;
  treeAssumeUtcForIsoDateTime: boolean;
  treeAssumeUtcForIsoDateOnly: boolean;
  historyTrackingMode: 'save_only' | 'all_actions';
  searchCaseSensitive: boolean;
  searchRegexMode: boolean;
  searchScope: 'keys' | 'values' | 'both';
  blobQuotaStrategy: 'auto_fifo' | 'manual';
  seenBlobQuotaModal: boolean;
  seenClipboardBanner: boolean;
  treeHighlightColors: TreeHighlightColors;
}

export type HistoryAction = 'saved' | 'viewed' | 'edited' | 'deleted' | 'pasted';

export interface HistoryEntry {
  id: string;
  userId: string;
  blobId?: string;
  slug?: string;
  title?: string;
  accessedAt: string;
  action: HistoryAction;
}

export interface FormattingStyle {
  backgroundColor?: string;
  textColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  borderColor?: string;
  icon?: string;
}

export interface FormattingRule {
  id: string;
  target: 'key' | 'value' | 'key_and_value';
  matchType: 'exact' | 'contains' | 'regex' | 'starts_with' | 'ends_with';
  matchValue: string;
  caseSensitive: boolean;
  style: FormattingStyle;
}

export interface FormattingRuleSet {
  id: string;
  userId: string;
  name: string;
  rules: FormattingRule[];
  createdAt: string;
  updatedAt: string;
}
