const IMAGE_MAX_BYTES = 6_000_000;
const PHOTO_WIDTH = 720;
const PHOTOS_PER_QUERY = 3;
const QUERY_MAX = 80;

const photoCache = new Map<string, Promise<string[]>>();

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function fetchImage(url: string): Promise<string> {
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });

  if (!response.ok) throw new Error(`图片取不到（${response.status}）`);
  const blob = await response.blob();

  if (!blob.type.startsWith("image/") || blob.size > IMAGE_MAX_BYTES) throw new Error("不是可用的图片");

  return dataUrl(blob);
}

function wikimediaImage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  try {
    const url = new URL(value);

    return url.protocol === "https:" && url.hostname === "upload.wikimedia.org" ? url.href : undefined; // WHY: hardcode-ok 这是图片来源白名单，是安全边界，不是按网站猜用户意图。
  } catch {
    return undefined;
  }
}

async function wikipediaPhotos(language: string, query: string): Promise<string[]> {
  const params = new URLSearchParams({ action: "query", format: "json", formatversion: "2", generator: "search", gsrsearch: query, gsrlimit: "5", prop: "pageimages", piprop: "thumbnail", pithumbsize: String(PHOTO_WIDTH) });
  const response = await fetch(`https://${language}.wikipedia.org/w/api.php?${params}`, { credentials: "omit", referrerPolicy: "no-referrer" });

  if (!response.ok) return [];
  const body = await response.json() as { query?: { pages?: { index?: number; thumbnail?: { source?: unknown } }[] } };

  return (body.query?.pages ?? [])
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((page) => wikimediaImage(page.thumbnail?.source) ?? [])
    .filter((url) => !/\.svg|logo|flag|coat_of_arms|icon/i.test(url));
}

async function findPhotos(query: string): Promise<string[]> {
  const languages = /\p{Script=Han}/u.test(query) ? ["zh", "en"] : ["en", "zh"];

  for (const language of languages) {
    const urls = await wikipediaPhotos(language, query).catch(() => []);
    const images = await Promise.all(urls.slice(0, PHOTOS_PER_QUERY).map((url) => fetchImage(url).catch(() => undefined)));
    const found = images.filter((image): image is string => !!image);

    if (found.length) return found;
  }

  return [];
}

function photos(query: unknown): Promise<string[]> {
  if (typeof query !== "string" || !query.trim() || query.length > QUERY_MAX) return Promise.resolve([]);
  const key = query.trim();
  let request = photoCache.get(key);

  if (!request) {
    request = findPhotos(key);
    photoCache.set(key, request);
  }

  return request;
}

function tile(arg: unknown): Promise<string> {
  const { z, x, y } = (arg ?? {}) as { z?: unknown; x?: unknown; y?: unknown };

  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || (z as number) < 0 || (z as number) > 18) return Promise.reject(new Error("地图位置无效"));
  const size = 2 ** (z as number);
  const column = (((x as number) % size) + size) % size;

  if ((y as number) < 0 || (y as number) >= size) return Promise.reject(new Error("地图位置无效"));

  return fetchImage(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${column}`);
}

// WHY: 沙箱里的界面由模型写成，可能受网页内容诱导。地址只由这里拼，不接受模型给的地址（维基图片除外），网页数据就不会被带到别的网站。
export function answerUiNet(op: unknown, arg: unknown): Promise<unknown> {
  if (op === "tile") return tile(arg);

  if (op === "photos") return photos(arg);

  if (op === "image") {
    const url = wikimediaImage(arg);

    return url ? fetchImage(url) : Promise.reject(new Error("这个图片地址不能用"));
  }

  return Promise.reject(new Error("不支持这个操作"));
}
