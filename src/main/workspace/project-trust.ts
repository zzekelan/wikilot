import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";

/** Main-owned adapter around Pi's durable project trust store. */
export type ProjectTrustDecision = "trusted" | "untrusted" | "undecided";

export type ProjectTrustEvaluation = {
  requiresDecision: boolean;
  decision: ProjectTrustDecision;
  projectTrusted: boolean;
};

export type ProjectTrustService = {
  evaluate(cwd: string): ProjectTrustEvaluation;
  set(cwd: string, trusted: boolean): void;
};

export function createProjectTrustService(agentDir: string): ProjectTrustService {
  const store = new ProjectTrustStore(agentDir);
  return {
    evaluate(cwd) {
      const requiresDecision = hasTrustRequiringProjectResources(cwd);
      const stored = store.get(cwd);
      const decision =
        stored === true ? "trusted" : stored === false ? "untrusted" : "undecided";
      return {
        requiresDecision,
        decision,
        projectTrusted: !requiresDecision || decision === "trusted",
      };
    },
    set(cwd, trusted) {
      store.set(cwd, trusted);
    },
  };
}
