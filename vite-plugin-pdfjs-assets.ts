import {
  createReadStream,
  cpSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Connect, Plugin, ResolvedConfig } from "vite";

const require = createRequire(import.meta.url);
const PDFJS_ROOT = resolve(
  require.resolve("pdfjs-dist/package.json"),
  "..",
);

const ASSET_MOUNTS = [
  { urlPrefix: "/pdfjs/cmaps/", dir: join(PDFJS_ROOT, "cmaps") },
  {
    urlPrefix: "/pdfjs/standard_fonts/",
    dir: join(PDFJS_ROOT, "standard_fonts"),
  },
] as const;

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".bcmap":
      return "application/octet-stream";
    case ".pfb":
    case ".ttf":
      return "application/octet-stream";
    default:
      return "application/octet-stream";
  }
}

function createPdfjsAssetsMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const urlPath = (req.url ?? "").split("?")[0] ?? "";
    for (const mount of ASSET_MOUNTS) {
      if (!urlPath.startsWith(mount.urlPrefix)) continue;
      const rel = decodeURIComponent(urlPath.slice(mount.urlPrefix.length));
      if (!rel || rel.includes("\0") || rel.split("/").includes("..")) {
        res.statusCode = 400;
        res.end("Bad path");
        return;
      }
      const absolute = resolve(mount.dir, ...rel.split("/"));
      const relativeToRoot = relative(mount.dir, absolute);
      if (
        relativeToRoot.startsWith(`..${sep}`) ||
        relativeToRoot === ".." ||
        !existsSync(absolute) ||
        !statSync(absolute).isFile()
      ) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeFor(absolute));
      res.setHeader("Cache-Control", "public, max-age=86400");
      createReadStream(absolute).pipe(res);
      return;
    }
    next();
  };
}

/**
 * Serves pdf.js CMap / standard-font assets for Viewer PDF rendering (CJK).
 * Dev + preview via middleware; production build copies into outDir.
 */
export function pdfjsAssetsPlugin(): Plugin {
  let outDir = "dist";

  return {
    name: "wikilot-pdfjs-assets",
    configResolved(config: ResolvedConfig) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use(createPdfjsAssetsMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createPdfjsAssetsMiddleware());
    },
    writeBundle() {
      for (const mount of ASSET_MOUNTS) {
        const dest = join(
          outDir,
          mount.urlPrefix.replace(/^\//, "").replace(/\/$/, ""),
        );
        mkdirSync(dest, { recursive: true });
        cpSync(mount.dir, dest, { recursive: true });
      }
    },
  };
}
