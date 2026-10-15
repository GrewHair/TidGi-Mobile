import { normalizeGitCloneUrl } from '../services/WikiImportService/gitCloneCacheUtilities';
import type { GitQRData } from './importQRCode';

export function deriveWorkspaceNameFromGitUrl(gitUrl: string): string {
  const parsed = new URL(gitUrl);
  const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? 'wiki';
  return decodeURIComponent(lastSegment).replace(/\.git$/i, '');
}

export function deriveWorkspaceIdFromGitUrl(gitUrl: string, preferredName?: string): string {
  const baseName = preferredName ?? deriveWorkspaceNameFromGitUrl(gitUrl);
  const slug = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const safeSlug = slug.length > 0 ? slug : 'wiki';
  return `${safeSlug}-${Date.now().toString(36)}`;
}

const OWNER_SLASH_REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/**
 * Turn what a user types into the import form for a Git host (GitHub, Gitea, …)
 * into the same data a desktop QR code provides. Accepts `owner/repo` (GitHub),
 * `github.com/owner/repo`, or a full http(s) URL of any host.
 *
 * @returns undefined when the input is not a repository URL.
 */
export function parseGitHostRepository(input: string, token: string): GitQRData | undefined {
  let text = input.trim();
  if (text === '') return undefined;
  if (OWNER_SLASH_REPOSITORY.test(text)) {
    text = `https://github.com/${text}`;
  } else if (!/^https?:\/\//i.test(text)) {
    text = `https://${text}`;
  }

  let gitUrl: string;
  try {
    gitUrl = normalizeGitCloneUrl(text);
  } catch {
    return undefined;
  }
  const parsed = new URL(gitUrl);
  if (!parsed.hostname.includes('.') || parsed.pathname.split('/').filter(Boolean).length < 2) return undefined;

  const workspaceName = deriveWorkspaceNameFromGitUrl(gitUrl);
  const trimmedToken = token.trim();
  return {
    baseUrl: parsed.origin,
    gitUrl,
    workspaceId: deriveWorkspaceIdFromGitUrl(gitUrl, workspaceName),
    workspaceName,
    ...(trimmedToken === '' ? {} : { token: trimmedToken }),
  };
}
