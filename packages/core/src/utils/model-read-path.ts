import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

function denied(): never {
  throw Object.assign(new Error("File access denied."), { code: "MODEL_FILE_ACCESS_DENIED" });
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function isCredentialPath(projectRoot: string, path: string): boolean {
  const parts = relative(projectRoot, path).split(/[\\/]/u).map(part => part.toLowerCase());
  const name = parts.at(-1) ?? "";
  if (/^\.env(?:rc)?(?:$|[.\-~_])/u.test(name)) return true;
  if (parts.length === 2 && parts[0] === ".inkos" && /^secrets(?:\.json)?(?:[.\-~_].*)?$/u.test(name)) return true;
  return parts.length === 1 && /^inkos(?:\.json(?:[.\-~_].*)?|[._-](?:bak|backup|old)(?:\..+)?)$/u.test(name);
}

/** Resolve a model-supplied project path without following it outside its scope. */
export async function resolveModelReadPath(projectRoot: string, scopeRoot: string, requested: string): Promise<string> {
  if (isAbsolute(requested) || win32.isAbsolute(requested) || /^[a-z]:/iu.test(requested)) denied();
  const normalized = requested.replace(/[\\/]/gu, sep);
  const project = resolve(projectRoot);
  const scope = resolve(scopeRoot);
  const candidate = resolve(scope, normalized);
  if (!within(project, scope) || !within(scope, candidate) || isCredentialPath(project, candidate)) denied();
  const [physicalProject, physicalScope, physicalCandidate] = await Promise.all([
    realpath(project), realpath(scope), realpath(candidate),
  ]);
  if (!within(physicalProject, physicalScope) || !within(physicalScope, physicalCandidate)
    || isCredentialPath(physicalProject, physicalCandidate)) denied();
  return physicalCandidate;
}
