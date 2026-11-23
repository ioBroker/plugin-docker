import type { ImageInfo } from '../types';

/** The parts of an image reference `[registry[:port]/]path[:tag][@digest]` */
export interface ImageRef {
    /** Repository with registry, e.g. `openthread/otbr` or `localhost:5000/tools/app` */
    name: string;
    tag?: string;
    /** e.g. `sha256:e7f6...` */
    digest?: string;
}

/**
 * Split an image reference. The tag is separated at the last `:` after the last `/`, so a registry
 * with a port (`localhost:5000/app`) is not taken for a tag.
 */
export function parseImageRef(ref: string): ImageRef {
    let rest = (ref || '').trim();
    let digest: string | undefined;
    const at = rest.indexOf('@');
    if (at !== -1) {
        digest = rest.slice(at + 1);
        rest = rest.slice(0, at);
    }
    let tag: string | undefined;
    const colon = rest.lastIndexOf(':');
    if (colon > rest.lastIndexOf('/')) {
        tag = rest.slice(colon + 1);
        rest = rest.slice(0, colon);
    }
    return { name: rest, tag, digest };
}

/** Add `:latest` to a reference without tag and digest, as docker does */
export function normalizeImageRef(ref: string): string {
    const trimmed = (ref || '').trim();
    const parsed = parseImageRef(trimmed);
    return parsed.tag || parsed.digest ? trimmed : `${parsed.name}:latest`;
}

/** Docker Hub names in their short form: `docker.io/library/nginx` and `library/nginx` are `nginx` */
function canonicalName(name: string): string {
    return name.replace(/^(?:index\.)?docker\.io\//, '').replace(/^library\//, '');
}

/**
 * The identity of a reference for comparisons: a digest names exactly one image and wins over a tag
 * (`nginx:1.27@sha256:...` is the same image as `nginx@sha256:...`), otherwise name and tag.
 */
export function imageRefKey(ref: string): string {
    const parsed = parseImageRef(normalizeImageRef(ref));
    const name = canonicalName(parsed.name);
    return parsed.digest ? `${name}@${parsed.digest}` : `${name}:${parsed.tag}`;
}

/** Whether a reference is pinned to a digest */
export function isDigestRef(ref: string): boolean {
    return !!parseImageRef(ref).digest;
}

/**
 * Whether an image of `imageList()` is the referenced one: by any of its tags, or by any of its
 * digests for a reference with a digest.
 */
export function imageMatches(info: ImageInfo, ref: string): boolean {
    const wanted = imageRefKey(ref);
    const candidates =
        info.tags || info.digests
            ? [...(info.tags || []), ...(info.digests || [])]
            : [`${info.repository}:${info.tag}`];
    return candidates.some(candidate => {
        const parsed = parseImageRef(candidate);
        if (!parsed.tag && !parsed.digest) {
            return false;
        }
        return imageRefKey(candidate) === wanted;
    });
}

/** `<none>:<none>` and `<none>@<none>` are what docker reports for images without tag or digest */
function isNone(ref: string): boolean {
    return !ref || ref.startsWith('<none>');
}

/** Build the `ImageInfo` of an entry of `GET /images/json` (dockerode `listImages()`) */
export function imageInfoFromApi(img: {
    Id: string;
    RepoTags?: string[] | null;
    RepoDigests?: string[] | null;
    Created: number;
    Size: number;
}): ImageInfo {
    const tags = (img.RepoTags || []).filter(t => !isNone(t));
    const digests = (img.RepoDigests || []).filter(d => !isNone(d));
    const first = tags[0] ? parseImageRef(tags[0]) : digests[0] ? parseImageRef(digests[0]) : undefined;
    return {
        repository: first?.name || '<none>',
        tag: (tags[0] && first?.tag) || '<none>',
        tags,
        digests,
        id: img.Id.startsWith('sha256:') ? img.Id.substring(7, 19) : img.Id.substring(0, 12),
        createdSince: new Date(img.Created * 1000).toISOString(),
        size: img.Size,
    };
}

/** The `--format` of `docker images` that {@link imageInfoFromCli} reads */
export const CLI_IMAGES_FORMAT = '{{.Repository}};{{.Tag}};{{.Digest}};{{.ID}};{{.CreatedAt}};{{.Size}}';

/**
 * Build the `ImageInfo` of a line of `docker images --digests --format CLI_IMAGES_FORMAT`.
 * The CLI prints one line per tag.
 *
 * @param line one line of the output
 * @param parseSize converts the human-readable size of docker into bytes
 */
export function imageInfoFromCli(line: string, parseSize: (size: string) => number): ImageInfo {
    const [repository, tag, digest, id, createdSince, size] = line.split(';');
    const named = !isNone(repository);
    return {
        repository,
        tag,
        tags: named && !isNone(tag) ? [`${repository}:${tag}`] : [],
        digests: named && !isNone(digest) ? [`${repository}@${digest}`] : [],
        id,
        createdSince,
        size: parseSize(size),
    };
}
