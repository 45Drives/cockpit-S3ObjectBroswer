export function formatBytes(n: number) {
    if (!Number.isFinite(n)) return "—";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    const dp = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
    return `${v.toFixed(dp)} ${units[i]}`;
}

export function formatDate(iso?: string | null) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
}

export function normalizePrefix(p: string): string {
    let s = (p || "").trim();

    // allow users to paste "/photos/2025/" or "photos/2025"
    while (s.startsWith("/")) s = s.slice(1);

    // collapse multiple slashes
    s = s.replace(/\/+/g, "/");

    // root
    if (s === "" || s === "/") return "";

    // ensure trailing slash so S3 "folder view" works with Delimiter="/"
    if (!s.endsWith("/")) s += "/";

    return s;
}

export function normalizePrefixNoLead(p: string): string {
    let s = (p || "").replace(/^\/+/, "");
    if (s && !s.endsWith("/")) s += "/";
    return s;
}

export function basenameFromKey(k: string) {
    const parts = (k || "").split("/");
    return parts[parts.length - 1] || k;
}

export function folderNameFromPrefix(p: string) {
    const s = normalizePrefixNoLead(p);
    const trimmed = s.endsWith("/") ? s.slice(0, -1) : s;
    const parts = trimmed.split("/").filter(Boolean);
    return parts[parts.length - 1] || trimmed || "folder";
}

export function joinKey(prefix: string, name: string): string {
    const p = normalizePrefix(prefix);
    if (!p) return name.replace(/^\/+/, "");
    return p + name.replace(/^\/+/, "");
}

export function nameFromPrefix(p: string) {
    const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
    const parts = trimmed.split("/").filter(Boolean);
    return parts[parts.length - 1] || trimmed;
}

export function nameFromKey(k: string) {
    const parts = (k || "").split("/");
    return parts[parts.length - 1] || k;
}

export function fileExt(name: string) {
    const base = (name || "").split("/").pop() || "";
    const i = base.lastIndexOf(".");
    if (i <= 0) return "";
    return base.slice(i + 1).toLowerCase();
}

export function isSystemFile(name: string, key: string) {
    const base = (name || "").split("/").pop() || name || "";
    if (base.startsWith(".")) return true;
    if (base.toLowerCase() === "thumbs.db") return true;
    if (base.toLowerCase() === "desktop.ini") return true;
    if (base.endsWith("~")) return true;
    if (key.includes("/.") || key.includes("\\.")) return true;
    return false;
}

export function isTextFile(ext: string) {
    return new Set([
        "txt", "md", "markdown", "log",
        "json", "yaml", "yml", "xml", "csv",
        "ini", "cfg", "conf",
        "js", "ts", "tsx", "jsx",
        "py", "go", "rs", "java", "c", "cpp", "h", "hpp",
        "html", "css", "scss",
        "sh", "bash", "zsh",
    ]).has(ext);
}

export function isApplicationFile(ext: string) {
    return new Set([
        "exe", "msi", "dmg", "pkg", "app",
        "deb", "rpm", "apk",
        "jar", "war",
        "bin",
    ]).has(ext);
}

export function guessFileTypeFromKey(key: string): string {
    const ext = fileExt(key);
    if (!ext) return "File";

    if (isTextFile(ext)) return "text";
    if (isApplicationFile(ext)) return "application";

    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"].includes(ext)) return "image";
    if (["mp4", "mov", "mkv", "webm", "avi"].includes(ext)) return "video";
    if (["mp3", "wav", "flac", "aac", "ogg"].includes(ext)) return "audio";
    if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar"].includes(ext)) return "archive";
    if (["pdf"].includes(ext)) return "pdf";

    return ext; // fallback: show extension
}
export function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function newJobId(): string {
    const c: any = globalThis.crypto as any;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}


