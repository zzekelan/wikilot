/**
 * Serializable Credential metadata. Only non-secret fields ever cross the
 * wire — plaintext API keys and OAuth tokens stay inside Pi's CredentialStore.
 */
export type CredentialType = "api_key" | "oauth";

export type AuthenticationType = CredentialType;

export type AuthenticationPrompt =
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string };

export type AuthenticationEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export type AuthenticationSessionEvent =
  | { type: "authentication_prompt"; sessionId: string; promptId: string; prompt: AuthenticationPrompt }
  | { type: "authentication_event"; sessionId: string; event: AuthenticationEvent }
  | { type: "authentication_completed"; sessionId: string; credential: ProviderCredential }
  | { type: "authentication_failed"; sessionId: string; message: string }
  | { type: "authentication_cancelled"; sessionId: string };

export type AuthenticationStartRequest = {
  providerId: string;
  type: AuthenticationType;
};

export type AuthenticationStartResponse = { sessionId: string };
export type AuthenticationRespondRequest = { sessionId: string; promptId: string; value: string };
export type AuthenticationCancelRequest = { sessionId: string };

export type ProviderCredential = {
  providerId: string;
  type: CredentialType;
};

/** Save (create/update) an API-key Credential for a provider. */
export type SetCredentialRequest = {
  providerId: string;
  apiKey: string;
};

export type DeleteCredentialRequest = {
  providerId: string;
};

export const PROVIDER_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

export const PROVIDER_AUTH_MODES = ["api_key", "none"] as const;

export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODES)[number];

export const PROVIDER_MODEL_INPUTS = ["text", "image"] as const;

export type ProviderModelInput = (typeof PROVIDER_MODEL_INPUTS)[number];

export type ThinkingLevelMap = Partial<
  Record<ThinkingLevel, string | null>
>;

/** Pi-native model metadata owned by a User Provider. */
export type ProviderModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ProviderModelInput[];
};

export const PROVIDER_INPUT_FIELDS = [
  "providerId",
  "name",
  "baseUrl",
  "protocol",
  "authMode",
  "models",
] as const;

export const PROVIDER_MODEL_FIELDS = [
  "id",
  "name",
  "contextWindow",
  "maxTokens",
  "reasoning",
  "thinkingLevelMap",
  "input",
] as const;

export function assertKnownFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
  context: string,
): void {
  const unknownField = Object.keys(value).find(
    (field) => !allowedFields.includes(field),
  );
  if (unknownField !== undefined) {
    throw new Error(`${context} contains unsupported field "${unknownField}"`);
  }
}

/** Provider fields accepted when creating or editing a User Provider. */
export type ProviderInput = {
  providerId: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  authMode: ProviderAuthMode;
  models: ProviderModel[];
};

export type ProviderSource = "builtin" | "user";

/** Secret-free Provider summary used by Settings and the model picker. */
export type ProviderSummary = Omit<ProviderInput, "protocol" | "authMode"> & {
  protocol?: ProviderProtocol;
  authMode?: ProviderAuthMode;
  source: ProviderSource;
  authenticated: boolean;
  supportsApiKey: boolean;
  supportsOAuth?: boolean;
  oauthLabel?: string;
};

export type ProviderListResponse = {
  providers: ProviderSummary[];
};

export type DeleteProviderRequest = {
  providerId: string;
};

export type CredentialListResponse = {
  credentials: ProviderCredential[];
};

export type ApiErrorBody = {
  error: string;
};

/** Provider/model ids exposed by the serializable Base Model Catalog. */
export type ModelCatalogProvider = {
  id: string;
  name: string;
  models: Array<{
    id: string;
    name: string;
    thinkingLevels: ThinkingLevel[];
  }>;
};

export type ModelCatalogResponse = {
  providers: ModelCatalogProvider[];
};

/** Pi thinking levels selectable as an App default. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * App Defaults for new Sessions. Existing Sessions keep the configuration
 * snapshot written into their own history, so changing Defaults never
 * reconfigures them.
 */
export type SessionModelDefault = {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
};

export type AppDefaults = {
  sessionModel?: SessionModelDefault;
  wikiPromptEnabled: boolean;
};

/** Live application preference, read at the next Automatic Review. */
export type ReviewSettings = {
  model: { provider: string; model: string } | null;
};

/** Complete replacements for new-Session defaults. */
export type AppDefaultsUpdate = {
  sessionModel?: SessionModelDefault;
  wikiPromptEnabled?: boolean;
};

export const DEFAULT_APP_DEFAULTS: AppDefaults = {
  wikiPromptEnabled: true,
};
