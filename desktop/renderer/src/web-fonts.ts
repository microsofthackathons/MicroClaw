const GOOGLE_FONTS_ORIGIN = "https://fonts.googleapis.com";
const GOOGLE_STATIC_ORIGIN = "https://fonts.gstatic.com";
const FONT_STYLESHEET =
  `${GOOGLE_FONTS_ORIGIN}/css2?` +
  "family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&" +
  "family=Noto+Sans+SC:wght@400;500;600;700&display=swap";
const FONT_STYLESHEET_ID = "microclaw-web-fonts";

function appendLink(document: Document, rel: string, href: string, crossOrigin = "") {
  const link = document.createElement("link");
  link.rel = rel;
  link.href = href;
  if (crossOrigin) link.crossOrigin = crossOrigin;
  document.head.appendChild(link);
}

export function loadWebFonts(document: Document = window.document): void {
  if (document.getElementById(FONT_STYLESHEET_ID)) return;

  appendLink(document, "preconnect", GOOGLE_FONTS_ORIGIN);
  appendLink(document, "preconnect", GOOGLE_STATIC_ORIGIN, "anonymous");

  const stylesheet = document.createElement("link");
  stylesheet.id = FONT_STYLESHEET_ID;
  stylesheet.rel = "stylesheet";
  stylesheet.href = FONT_STYLESHEET;
  document.head.appendChild(stylesheet);
}

export function loadWebFontsAfterPageLoad(
  document: Document = window.document,
  targetWindow: Window = window,
): void {
  if (document.readyState === "complete") {
    loadWebFonts(document);
    return;
  }
  targetWindow.addEventListener("load", () => loadWebFonts(document), { once: true });
}
