import { join } from "node:path";
interface WindowLoader {
  loadURL: (url: string) => Promise<unknown>;
  loadFile: (
    path: string,
    options: { query: Record<string, string> },
  ) => Promise<unknown>;
}
export async function loadRenderer(
  window: WindowLoader,
  options: {
    packaged: boolean;
    mainDirectory: string;
    developmentURL?: string;
    type: string;
    id: string;
  },
) {
  const query = { view: options.type, id: options.id };
  if (!options.packaged && options.developmentURL) {
    const url = new URL(options.developmentURL);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    await window.loadURL(url.toString());
  } else {
    // A packaged application always loads its bundled page, even when launched
    // from a shell carrying an Electron/Vite development URL.
    await window.loadFile(
      join(options.mainDirectory, "../renderer/index.html"),
      { query },
    );
  }
}
