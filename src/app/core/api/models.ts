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
  treeShowTypeLabels: boolean;
  treeShowDateAnnotations: boolean;
  historyTrackingMode: 'save_only' | 'all_actions';
  searchCaseSensitive: boolean;
  searchRegexMode: boolean;
  searchScope: 'keys' | 'values' | 'both';
  blobQuotaStrategy: 'auto_fifo' | 'manual';
  seenBlobQuotaModal: boolean;
  treeHighlightColors: TreeHighlightColors;
}

export interface HistoryEntry {
  id: string;
  userId: string;
  blobId: string;
  accessedAt: string;
  action: 'saved' | 'viewed' | 'edited' | 'pasted';
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
