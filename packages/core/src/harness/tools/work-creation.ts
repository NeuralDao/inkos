import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBuiltInWorkProfileRegistry } from "../builtin-profiles.js";
import { createInitialWorkManifestWrite } from "../source-sync.js";
import { loadWorkManifest } from "../work-store.js";
import { commitAtomicFileSet } from "../../utils/atomic-file-set.js";
import { StateManager } from "../../state/manager.js";
import { withWorkMutationScope } from "../../utils/work-mutation-scope.js";
import type { CapabilityRegistry } from "../capability-registry.js";
import { readArtifactRevision } from "../artifact-reader.js";
import type { AtomicFileWrite } from "../../utils/atomic-file-set.js";
import { LONGFORM_CREATION_LANGUAGES } from "../../utils/book-language.js";
const CreateParameters = Type.Object({ workId: Type.String(), profileId: Type.String(), title: Type.String({ minLength: 1 }), intent: Type.String({ minLength: 1 }), language: Type.Optional(Type.String()),
  narrativeLanguage: Type.Optional(Type.Union([Type.Literal("en"), Type.Literal("zh"), Type.Literal("ru")])),
  source: Type.Optional(Type.Object({workId:Type.String(),artifactId:Type.String(),revisionId:Type.Optional(Type.String())},{additionalProperties:false,description:"Only for adaptation or derivation from an existing Work: pass a verified source text artifact from read/inspect_work. Omit for an original Work. The host preserves that exact revision for production and review; do not invent IDs or summarize/copy its text into intent."})),
});
export function createProfileWorkTools(root: string, capabilities: CapabilityRegistry): AgentTool<any>[] {
  return [
    { name: "list_work_profiles", label: "List creative profiles", description: "List installed creative profiles and the methods and actions they compose.", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: JSON.stringify(createBuiltInWorkProfileRegistry(root).list()) }], details: { kind: "work_profiles" } }),
    },
    { name: "create_work", label: "Create work from profile", description: "Create and bind a Work using an installed Profile, persist the user's brief, and activate the Profile's production actions for the next step. Long-form Work language is fixed by this fork: operational en, narrative ru. For original work, omit source. Only when deriving from an existing work, supply a verified source artifact reference.", parameters: CreateParameters,
      execute: async (_id, params) => {
        const profile = createBuiltInWorkProfileRegistry(root).require(params.profileId);
        const longform = profile.capabilityIds.includes("longform");
        if (!longform && params.narrativeLanguage !== undefined) throw new Error("narrativeLanguage is supported only for long-form Works.");
        const bookLanguages = longform ? LONGFORM_CREATION_LANGUAGES : undefined;
        capabilities.forProfile(profile);
        return withWorkMutationScope(root, params.workId, () => new StateManager(root).acquireBookLock(params.workId), async () => {
          try { await loadWorkManifest(root, params.workId); throw Object.assign(new Error("Work already exists"), { code: "WORK_ALREADY_EXISTS" }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          const writes: AtomicFileWrite[] = [{ relativePath: `works/${params.workId}/source/brief.md`, content: params.intent }];
          const lineage = [];
          if (params.source) {
            let source: Awaited<ReturnType<typeof readArtifactRevision>>;
            try {
              source = await readArtifactRevision({projectRoot:root,workId:params.source.workId,artifactId:params.source.artifactId,revisionId:params.source.revisionId});
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw Object.assign(new Error(`Source Work "${params.source.workId}" was not found. Omit source when creating an original Work; for derivation, select an existing Work and artifact.`), { code: "SOURCE_WORK_NOT_FOUND" });
              }
              throw error;
            }
            if (!source.revision.contentType.startsWith('text/') && source.revision.contentType !== 'application/json') throw Object.assign(new Error('Derivation source must be a text artifact.'),{code:'SOURCE_NOT_TEXT'});
            writes.push({relativePath:`works/${params.workId}/source/source-material.md`,content:source.bytes});
            lineage.push({relation:'derived-from',sourceWorkId:source.work.id,sourceArtifactId:source.artifact.id,sourceRevisionId:source.revision.id});
          }
          const initial = createInitialWorkManifestWrite({ workId: params.workId, title: params.title, profileId: profile.id, language: bookLanguages?.language ?? params.language ?? "zh", writes, metadata: { intent: params.intent, ...(bookLanguages ? { narrativeLanguage: bookLanguages.narrativeLanguage } : {}) }, lineage });
          await commitAtomicFileSet({ rootDir: root, writes: [...writes, initial.write] });
          return { content: [{ type: "text", text: `Created ${params.title} with profile ${profile.id}.` }], details: { kind: "work_created", workId: params.workId, profileId: profile.id, lineage } };
        });
      },
    },
  ];
}
