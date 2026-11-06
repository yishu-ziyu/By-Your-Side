import "leaflet/dist/leaflet.css";

import { defineComponent, reactive, useIsStreaming, useStateField } from "@openuidev/react-lang";
import L from "leaflet";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod/v4";
import { askHost } from "../../host";
import { coordinate, pinEmoji, reducedMotion } from "./map-utils";

type Place = { key: string; label: string; lat: number; lng: number; category?: string; icon: string | null; order: number };

/** Markers as plain data. While streaming, only finished markers count, so a half-written -12 never moves a pin. */
function placesOf(markers: unknown, streaming: boolean): Place[] {
  const seen = new Map<string, number>();
  const out: Place[] = [];
  (Array.isArray(markers) ? markers.flat() : []).forEach((item, order) => {
    const el = item as { type?: string; partial?: boolean; props?: Record<string, unknown> } | null;
    if (el?.type !== "element" || !el.props || (streaming && el.partial)) return;
    const { label, lat, lng, category, icon } = el.props;
    if (typeof label !== "string" || !label.trim() || !coordinate({ lat, lng })) return;
    const count = seen.get(label) ?? 0;
    seen.set(label, count + 1);
    out.push({
      key: count ? `${label} (${count + 1})` : label,
      label,
      lat: lat as number,
      lng: lng as number,
      category: typeof category === "string" && category.trim() ? category.trim() : undefined,
      icon: pinEmoji(icon),
      order,
    });
  });
  return out;
}

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const hostTiles = (onFail: () => void) => {
  const Layer = L.GridLayer.extend({
    createTile(coords: L.Coords, done: L.DoneCallback) {
      const tile = document.createElement("img");
      tile.alt = "";
      askHost<string>("tile", { z: coords.z, x: coords.x, y: coords.y }).then(
        (data) => { tile.src = data; done(undefined, tile); },
        (error: Error) => { onFail(); done(error, tile); },
      );
      return tile;
    },
  });
  return new (Layer as unknown as new (options: L.GridLayerOptions) => L.GridLayer)({ attribution: "Esri", maxZoom: 18, tileSize: 256 });
};

export const MapMarker = defineComponent({
  name: "MapMarker",
  props: z.object({
    label: z.string(),
    lat: z.number(),
    lng: z.number(),
    category: z.string().optional(),
    icon: z.string().optional(),
  }),
  description: "A place on a Map; icon is one emoji, else the pin shows its number.",
  component: () => null,
});

export const MapView = defineComponent({
  name: "Map",
  props: z.object({
    markers: z.array(MapMarker.ref),
    route: z.boolean().optional(),
    selected: reactive(z.string().optional()),
    height: z.number().optional(),
  }),
  description: "Street map fitted to its markers. route joins the places in marker order with a straight dashed line, which only shows the order and is not a driving route; selected holds the clicked marker's label.",
  component: function MapComponent({ props, statementId }) {
    const streaming = useIsStreaming();
    const fallbackId = useId();
    const selection = useStateField(statementId ?? `map-${fallbackId}`, props.selected);
    const selected = typeof selection.value === "string" ? selection.value : null;
    const surface = useRef<HTMLDivElement>(null);
    const map = useRef<L.Map | null>(null);
    const layer = useRef<L.LayerGroup | null>(null);
    const select = useRef<(label: string) => void>(() => {});
    const framed = useRef("");
    const [group, setGroup] = useState("all");
    const [tilesFailed, setTilesFailed] = useState(false);
    const height = Math.min(480, Math.max(200, props.height ?? 300));

    const places = placesOf(props.markers, streaming);
    const visible = places.filter((p) => group === "all" || p.category === group);
    const categories = Array.from(new Set(places.map((p) => p.category).filter((c): c is string => !!c)));
    const signature = JSON.stringify(visible.map((p) => [p.key, p.lat, p.lng, p.icon, p.order]));
    select.current = (label) => selection.setValue(label);

    useEffect(() => {
      if (!surface.current || map.current) return;
      const instance = L.map(surface.current, { zoomControl: true, scrollWheelZoom: false, fadeAnimation: false, attributionControl: true });
      instance.attributionControl.setPrefix(false);
      hostTiles(() => setTilesFailed(true)).addTo(instance);
      instance.setView([20, 0], 1);
      layer.current = L.layerGroup().addTo(instance);
      map.current = instance;
      const resize = new ResizeObserver(() => instance.invalidateSize());
      resize.observe(surface.current);
      return () => { resize.disconnect(); instance.remove(); map.current = null; layer.current = null; };
    }, []);

    useEffect(() => {
      const instance = map.current;
      const group = layer.current;
      if (!instance || !group) return;
      group.clearLayers();
      visible.forEach((place, index) => {
        const html = `<div class="iui-map-marker-content"><span class="iui-map-pin${place.icon ? "" : " is-numbered"}${selected === place.key ? " is-selected" : ""}">${esc(place.icon ?? String(index + 1))}</span><span class="iui-map-label">${esc(place.label)}</span></div>`;
        L.marker([place.lat, place.lng], { title: place.label, keyboard: true, icon: L.divIcon({ className: "iui-map-marker", html, iconSize: [34, 54], iconAnchor: [17, 17] }) })
          .on("click", () => select.current(place.key))
          .addTo(group);
      });
      if (props.route && visible.length > 1) {
        L.polyline(visible.map((p) => [p.lat, p.lng] as [number, number]), { color: "var(--iui-ink)", weight: 2, opacity: 0.55, dashArray: "4 6", interactive: false }).addTo(group);
      }
      if (!streaming && visible.length && framed.current !== signature) {
        framed.current = signature;
        instance.fitBounds(L.latLngBounds(visible.map((p) => [p.lat, p.lng] as [number, number])), { padding: [44, 44], maxZoom: 13, animate: !reducedMotion() });
      }
    }, [signature, selected, streaming, props.route]);

    return (
      <div className="iui-map-slot">
        <div className="iui-map" style={{ height }} role="region" aria-label="地图">
          <div className="iui-map-surface" ref={surface} />
          {categories.length > 1 && (
            <div className="iui-map-top-left">
              <label className="iui-map-pill iui-map-filter">
                <select aria-label="筛选地点" value={group} onChange={(event) => setGroup(event.target.value)}>
                  <option value="all">全部地点</option>
                  {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              </label>
            </div>
          )}
          {props.route && visible.length > 1 && <div className="iui-map-overview">连线只表示顺序，不是实际路线</div>}
          {tilesFailed && <div className="iui-map-error" role="status">底图暂时取不到，地点还在。</div>}
        </div>
      </div>
    );
  },
});
