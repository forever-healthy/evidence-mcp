// Glyph names → characters, for the glyphs pdf.js leaves as control
// characters (U+0001–U+001F): a symbol font without a usable ToUnicode map
// still names each code in its /Differences array, and the names of the Adobe
// Pi fonts (MathematicalPi, Universal-GreekwithMathPi, EuropeanPi — also
// Advent's clones, AdvMathpi) mean the same glyph in every font. Advent's own
// Cn names are arbitrary per base font, so they are listed per family, and
// only for families whose fonts agreed. Every entry was checked against the
// glyph's outline in the library's PDFs and the text around it (src/pdf.ts, "Design notes: PDF glyphs",
// "PDF glyphs"); what the check could not settle is left out and stays counted
// as glyphs_unresolved.

// Adobe Pi names (Hnnnnn, Lnnnnn) and Monotype Greek names (afii…): one
// meaning everywhere.
export const PI_NAMES: Record<string, string> = {
  H11001: "+", H11002: "−", H11003: "×", H11005: "=", H11006: "±", H11009: "∞", H11011: "~", H11015: "~",
  H11021: "<", H11022: ">", H11032: "′", H11034: "°", H11349: "≤", H11350: "≥",
  H11545: "+", H11549: "=", H11554: "•", H11569: "*", H17004: "●", H17039: "▪",
  H20648: "‖", H20841: "|", H20851: "[", H20852: "]", H20862: "/", H20873: "(", H20874: ")",
  H9004: "Δ", H9018: "Σ", H9251: "α", H9252: "β", H9253: "γ", H9260: "κ", H9262: "μ", H9270: "τ", H9273: "χ",
  L1151: "+", L1152: "−", L1154: "×", L50140: ">", L50141: "<", L50512: "±", L50871: "≥",
  afii9797: "Δ", afii9825: "α", afii9826: "β", afii9839: "μ", Delta1: "Δ",
  "221e": "∞", "223c": "~", uni00b5: "μ",
};

// Advent base fonts: Cn names fixed within the family. AdvP4C4E74 is the
// symbol font of Elsevier's and Wiley's older PDFs; AdvMT_SY and AdvMacMthSyN
// share its C0/C2/C6 and were checked for those only.
export const FAMILY_NAMES: Record<string, Record<string, string>> = {
  AdvP4C4E74: { C0: "−", C1: ".", C2: "×", C3: "*", C6: "±", C15: "•", C20: "≤", C21: "≥", C24: "~" },
  AdvMT_SY: { C0: "−", C2: "×", C6: "±" },
  AdvMacMthSyN: { C0: "−", C2: "×", C6: "±" },
};

// "MNFBLL+AdvP4C4E74" → "AdvP4C4E74"; "Universal-GreekwithMathPi" → "Universal";
// "AdvOT863180fb+fb" → "AdvOT863180fb".
export const fontFamily = (name: string): string => name.replace(/^[A-Z]{6}\+/, "").replace(/[+-].*$/, "");

export function glyphChar(fontName: string, glyph: string): string | null {
  return PI_NAMES[glyph] ?? FAMILY_NAMES[fontFamily(fontName)]?.[glyph] ?? null;
}

// The character pdf.js emits for a glyph it cannot map: the glyph's code —
// except a name "Cnn"/"Cnnn" (2–3 digits), whose number it takes as the code
// (so AdvP4C4E74's C20 at code 3 comes out as U+0014). Inverted here: the
// emitted code → the glyph name, for one font's /Differences.
export function emittedNames(differences: Map<number, string>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [code, name] of differences) {
    const m = /^C(\d{2,3})$/.exec(name);
    const emitted = m ? Number(m[1]) : code;
    if (emitted < 0x20) out.set(emitted, name);
  }
  return out;
}
