import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";

// HTML → Markdown for article pages. The PMC page is cut to its article part
// (abstract + body, references) before conversion so navigation, banners and
// footers never end up in the library. Publisher pages are converted whole,
// with the furniture removed here:
//   * form controls, not <form>: ASP.NET sites (Silverchair — JAMA, OUP, …)
//     wrap the entire page in one <form>, article included (found 2026-10-28:
//     dropping forms left only the cookie dialog of a JAMA article)
//   * cookie/consent banners (OneTrust, GDPR wrappers), header/footer/aside
//   * <div class="h2|h3|…">: Silverchair's section headings are divs with a
//     heading class, not <h2>; they become headings so the methods/results
//     check and fh_library_read see the sections

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
td.use(gfm);
td.remove(["script", "style", "nav", "noscript", "iframe", "input", "select", "textarea", "header", "footer", "aside"]);
// Buttons are page controls and dropped — except one inside a heading that is not a dialog
// trigger: Examine's sections are questions in an expander button, <h3><button>What is
// creatine?</button></h3> (found 2026-11-15: 36 headings left as a bare "###").
const inHeading = (n: any): boolean => { for (let p = n.parentNode; p; p = p.parentNode) if (/^h[1-6]$/i.test(String(p.nodeName)) || (String(p.nodeName).toLowerCase() === "div" && /(^|\s)h[1-6](\s|$)/.test(String(p.className ?? "")))) return true; return false; };
td.addRule("buttons", {
  filter: (n: any) => String(n.nodeName).toLowerCase() === "button",
  replacement: (content: string, n: any) => inHeading(n) && !n.getAttribute?.("aria-haspopup") ? content : "",
});
// A heading on one line: block elements inside it (Examine's <h2><span><div>…) no longer put its
// text on the next line under a bare "##"; a heading with no text is dropped.
const heading = (level: number, content: string) => { const t = content.replace(/\s+/g, " ").trim(); return t ? `\n\n${"#".repeat(level)} ${t}\n\n` : "\n\n"; };
td.addRule("headings", { filter: ["h1", "h2", "h3", "h4", "h5", "h6"], replacement: (content: string, n: any) => heading(Number(String(n.nodeName).charAt(1)), content) });
const FURNITURE = /gdpr|cookie|onetrust|consent|advert|\bad-slot\b/i;
td.remove(((n: any) => ["div", "section"].includes(String(n.nodeName).toLowerCase()) && FURNITURE.test(`${n.className ?? ""} ${n.id ?? ""}`)) as any);
td.addRule("drop-svg", { filter: (n) => n.nodeName.toLowerCase() === "svg", replacement: () => "" });
td.addRule("drop-images", { filter: ["img"], replacement: () => "" });
td.addRule("div-headings", {
  filter: (n: any) => String(n.nodeName).toLowerCase() === "div" && /(^|\s)h[1-6](\s|$)/.test(String(n.className ?? "")),
  replacement: (content: string, n: any) => heading(Number(/(^|\s)h([1-6])(\s|$)/.exec(String(n.className))![2]), content),
});

export function htmlToMarkdown(html: string): string {
  return td.turndown(html).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
