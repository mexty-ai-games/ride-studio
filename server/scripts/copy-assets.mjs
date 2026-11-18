import { cpSync } from "node:fs";
cpSync(new URL("../src/preview/mock-viewer.html", import.meta.url), new URL("../dist/server/src/preview/mock-viewer.html", import.meta.url));
