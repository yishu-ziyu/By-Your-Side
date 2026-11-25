import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectComparableCluster } from "./tab-cluster.js";

describe("detectComparableCluster", () => {
  it("detects 3+ comparable tabs under the same host path bucket", () => {
    const cluster = detectComparableCluster([
      { tabId: 1, url: "https://shop.example.com/item/101", title: "A" },
      { tabId: 2, url: "https://shop.example.com/item/102", title: "B" },
      { tabId: 3, url: "https://shop.example.com/item/103", title: "C" },
      { tabId: 4, url: "https://news.example.com/home", title: "News" },
    ]);

    assert.ok(cluster);
    assert.equal(cluster.label, "对比这 3 个标签页");
    assert.deepEqual(cluster.tabs.map((t) => t.tabId), [1, 2, 3]);
  });

  it("groups numbered single-segment product pages and keeps distinct slugs apart", () => {
    const cluster = detectComparableCluster([
      { tabId: 1, url: "https://item.jd.com/100012043978.html", title: "A" },
      { tabId: 2, url: "https://item.jd.com/100049486783.html", title: "B" },
      { tabId: 3, url: "https://item.jd.com/10098765432.html", title: "C" },
      { tabId: 4, url: "https://www.example.com/about", title: "About" },
      { tabId: 5, url: "https://www.example.com/contact", title: "Contact" },
      { tabId: 6, url: "https://www.example.com/pricing", title: "Pricing" },
    ]);

    assert.ok(cluster);
    assert.deepEqual(cluster.tabs.map((t) => t.tabId), [1, 2, 3]);
  });

  it("ignores duplicate URLs and non-http tabs", () => {
    const cluster = detectComparableCluster([
      { tabId: 1, url: "chrome://extensions", title: "Ext" },
      { tabId: 2, url: "https://shop.example.com/item/101", title: "A" },
      { tabId: 3, url: "https://shop.example.com/item/101", title: "A dup" },
      { tabId: 4, url: "https://shop.example.com/item/102", title: "B" },
    ]);

    assert.equal(cluster, null);
  });
});
