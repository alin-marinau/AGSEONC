import { useState, useRef } from "react";
import Papa from "papaparse";

const TABS = ["Interogări Căutare", "Pagini Slabe", "CTR Scăzut", "Sugestii Conținut"];
const ICONS = { "Interogări Căutare": "🔍", "Pagini Slabe": "📉", "CTR Scăzut": "📊", "Sugestii Conținut": "✍️" };

const PRIO_COLOR = {
  "Critică": "bg-red-100 text-red-700 border-red-200",
  "Ridicată": "bg-orange-100 text-orange-700 border-orange-200",
  "Medie": "bg-yellow-100 text-yellow-700 border-yellow-200",
  "Scăzută": "bg-green-100 text-green-700 border-green-200",
};

function normalizeHeaders(row) {
  const map = {};
  for (const k of Object.keys(row)) {
    const clean = k.toLowerCase().trim().replace(/\s+/g, " ");
    if (clean.includes("query") || clean.includes("top queries") || clean.includes("interog")) map["query"] = row[k];
    if (clean.includes("page") || clean.includes("pagini") || clean.includes("url")) map["page"] = row[k];
    if (clean.includes("click")) map["clicks"] = parseFloat(row[k]) || 0;
    if (clean.includes("impres")) map["impressions"] = parseFloat(row[k]) || 0;
    if (clean.includes("ctr")) map["ctr"] = parseFloat(String(row[k]).replace("%","")) || 0;
    if (clean.includes("pos") || clean.includes("pozi")) map["position"] = parseFloat(row[k]) || 0;
  }
  return map;
}

function buildPrompt(tab, data, siteUrl) {
  return `Ești un expert SEO care ajută oameni fără cunoștințe tehnice să își optimizeze site-ul. Analizează datele din Google Search Console și generează un checklist de acțiuni în format JSON.

Structura JSON: {"checklist":[{"categorie":"...","prioritate":"Critică|Ridicată|Medie|Scăzută","actiune":"...","detalii":"...","unde":"...","pagina":"...","pasi":["pas 1","pas 2","pas 3"],"status":"de_facut"}]}

Reguli IMPORTANTE:
- "actiune": titlu scurt și clar al acțiunii (ex: "Îmbunătățește titlul paginii principale")
- "detalii": explică DE CE e importantă această acțiune, în termeni simpli, fără jargon tehnic
- "unde": spune EXACT unde trebuie mers pentru a face modificarea (ex: "În WordPress: Appearance → Customize → Site Identity" sau "În contul tău de hosting, la fișierul..." sau "Pe pagina ta, în secțiunea About")
- "pagina": URL-ul exact al paginii din site la care se referă acțiunea. Site-ul este: ${siteUrl || "necunoscut"}. Construiește URL-uri reale bazate pe paginile din datele GSC (ex: dacă vezi "/despre-noi" în date, pune "${siteUrl || "https://site.ro"}/despre-noi"). Dacă acțiunea e generală, pune URL-ul principal al site-ului.
- "pasi": listă de 3-6 pași simpli, numerotați, ca pentru cineva care nu știe nimic tehnic. Fiecare pas să înceapă cu un verb: "Deschide...", "Click pe...", "Scrie...", "Salvează..."
- Menționează query-uri și pagini CONCRETE din datele furnizate
- Minim 12 acțiuni
- Răspunde DOAR cu JSON, fără altceva.

Tip analiză: ${tab}
Date GSC:
${JSON.stringify(data.slice(0, 15), null, 2)}`;
}

export default function SEOAgent() {
  const [csvData, setCsvData] = useState(null);
  const [fileName, setFileName] = useState("");
  const [activeTab, setActiveTab] = useState("Interogări Căutare");
  const [checklists, setChecklists] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("Toate");
  const [siteUrl, setSiteUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef();

  function parseCSV(file) {
    setError("");
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: (res) => {
        const rows = res.data.map(normalizeHeaders).filter(r => r.query || r.page);
        if (!rows.length) { setError("CSV-ul nu pare să fie din Google Search Console. Verifică formatul."); return; }
        setCsvData(rows);
        setFileName(file.name);
        setChecklists({});
        setFilter("Toate");
      },
      error: () => setError("Eroare la parsarea CSV-ului.")
    });
  }

  function onDrop(e) {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) parseCSV(f);
  }

  function getTabData() {
    if (!csvData) return [];
    switch (activeTab) {
      case "Interogări Căutare":
        return [...csvData].sort((a, b) => b.impressions - a.impressions).slice(0, 30);
      case "Pagini Slabe":
        return csvData.filter(r => r.impressions > 100 && r.clicks < r.impressions * 0.03).sort((a, b) => b.impressions - a.impressions).slice(0, 30);
      case "CTR Scăzut":
        return csvData.filter(r => r.ctr < 2 && r.impressions > 50).sort((a, b) => a.ctr - b.ctr).slice(0, 30);
      case "Sugestii Conținut":
        return csvData.filter(r => r.position > 5 && r.impressions > 30).sort((a, b) => b.impressions - a.impressions).slice(0, 30);
      default: return csvData.slice(0, 30);
    }
  }

  async function analyze() {
    const data = getTabData();
    if (!data.length) { setError("Nu există date suficiente pentru această analiză în CSV-ul tău."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 8000,
          messages: [{ role: "user", content: buildPrompt(activeTab, data, siteUrl) }]
        })
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError(`Eroare API (${res.status}): ${errBody?.error?.message || "Necunoscută"}`);
        setLoading(false); return;
      }
      const d = await res.json();
      const raw = d.content?.map(b => b.text || "").join("") || "";
      if (!raw) { setError("Răspuns gol de la AI. Încearcă din nou."); setLoading(false); return; }
      // extrage primul obiect JSON complet prin numărare acolade
      let jsonStr = null;
      const start = raw.indexOf("{");
      if (start === -1) { setError("Formatul răspunsului AI e neașteptat. Încearcă din nou."); setLoading(false); return; }
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < raw.length; i++) {
        const c = raw[i];
        if (esc) { esc = false; continue; }
        if (c === "\\" && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === "{") depth++;
        if (c === "}") { depth--; if (depth === 0) { jsonStr = raw.slice(start, i + 1); break; } }
      }
      if (!jsonStr) { setError("Nu s-a putut extrage JSON din răspuns. Încearcă din nou."); setLoading(false); return; }
      const parsed = JSON.parse(jsonStr);
      const items = parsed.checklist || parsed.items || parsed.actions || [];
      if (!items.length) { setError("AI-ul nu a returnat acțiuni. Încearcă din nou."); setLoading(false); return; }
      setChecklists(prev => ({ ...prev, [activeTab]: items }));
      setFilter("Toate");
    } catch (e) {
      setError(`Eroare: ${e.message || "Necunoscută"}. Încearcă din nou.`);
    }
    setLoading(false);
  }

  function toggle(idx) {
    setChecklists(prev => {
      const list = [...(prev[activeTab] || [])];
      list[idx] = { ...list[idx], status: list[idx].status === "finalizat" ? "de_facut" : "finalizat" };
      return { ...prev, [activeTab]: list };
    });
  }

  const current = checklists[activeTab] || [];
  const filtered = filter === "Toate" ? current : filter === "Finalizate" ? current.filter(i => i.status === "finalizat") : current.filter(i => i.status === "de_facut");
  const done = current.filter(i => i.status === "finalizat").length;
  const pct = current.length ? Math.round((done / current.length) * 100) : 0;
  const cats = [...new Set(current.map(i => i.categorie))];
  const tabData = csvData ? getTabData() : [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 p-4 font-sans">
      <div className="max-w-4xl mx-auto">

        {/* Header */}
        <div className="text-center mb-7">
          <div className="inline-flex items-center gap-2 bg-blue-500/20 border border-blue-400/30 rounded-full px-4 py-1 mb-3">
            <span className="text-blue-300 text-sm font-medium">🤖 Powered by Claude AI</span>
          </div>
          <h1 className="text-3xl font-bold text-white mb-1">Agent SEO <span className="text-blue-400">AI</span></h1>
          <p className="text-slate-400 text-sm">Uploadează exportul CSV din Google Search Console</p>
        </div>

        {/* Site URL input */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5 mb-5">
          <label className="text-slate-300 text-sm font-medium mb-1 block">🌐 URL-ul site-ului tău</label>
          <input
            className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-blue-400 transition"
            placeholder="https://site-ul-tau.ro"
            value={siteUrl}
            onChange={e => setSiteUrl(e.target.value.replace(/\/$/, ""))}
          />
          <p className="text-slate-500 text-xs mt-1">Folosit pentru a genera link-uri directe către paginile ce trebuie optimizate</p>
        </div>

        {/* Upload Zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current.click()}
          className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition mb-5 ${
            dragging ? "border-blue-400 bg-blue-500/10" : csvData ? "border-green-500/50 bg-green-500/5" : "border-white/20 bg-white/5 hover:border-blue-400/50 hover:bg-white/8"
          }`}
        >
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={e => e.target.files[0] && parseCSV(e.target.files[0])} />
          {csvData ? (
            <div>
              <div className="text-4xl mb-2">✅</div>
              <p className="text-green-400 font-semibold">{fileName}</p>
              <p className="text-slate-400 text-sm mt-1">{csvData.length} rânduri încărcate · Click pentru a schimba fișierul</p>
            </div>
          ) : (
            <div>
              <div className="text-5xl mb-3">📂</div>
              <p className="text-white font-semibold text-lg">Drag & drop CSV sau click pentru upload</p>
              <p className="text-slate-400 text-sm mt-1">Export din GSC → Performanță → Exportare → CSV</p>
            </div>
          )}
        </div>

        {/* How to export guide */}
        {!csvData && (
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-2xl p-5 mb-5">
            <p className="text-blue-300 font-semibold mb-3">📋 Cum obții CSV-ul din Google Search Console:</p>
            <ol className="space-y-2 text-sm text-slate-300">
              {["Mergi la search.google.com/search-console", "Click pe Performanță → Rezultate de căutare", "Setează perioada: ultimele 90 zile", "Activează: Clicks ✓ Impressions ✓ CTR ✓ Position ✓", "Click Exportare (↑) → CSV → salvează fișierul", "Uploadează fișierul de mai sus"].map((s, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="bg-blue-500/30 text-blue-300 rounded-full w-5 h-5 flex items-center justify-center text-xs flex-shrink-0 mt-0.5">{i+1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {error && <p className="text-red-400 text-sm mb-4 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">⚠️ {error}</p>}

        {/* Stats preview */}
        {csvData && (
          <div className="grid grid-cols-4 gap-3 mb-5">
            {[
              { label: "Total rânduri", val: csvData.length, icon: "📄" },
              { label: "Pagini slabe", val: csvData.filter(r => r.impressions > 100 && r.clicks < r.impressions * 0.03).length, icon: "📉" },
              { label: "CTR scăzut", val: csvData.filter(r => r.ctr < 2 && r.impressions > 50).length, icon: "📊" },
              { label: "Oportunități", val: csvData.filter(r => r.position > 5 && r.impressions > 30).length, icon: "🎯" },
            ].map(s => (
              <div key={s.label} className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
                <div className="text-xl mb-1">{s.icon}</div>
                <div className="text-white font-bold text-xl">{s.val}</div>
                <div className="text-slate-400 text-xs mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        {csvData && (
          <>
            <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
              {TABS.map(t => (
                <button key={t} onClick={() => { setActiveTab(t); setFilter("Toate"); }}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition border ${
                    activeTab === t ? "bg-blue-500 border-blue-400 text-white shadow-lg shadow-blue-500/30" : "bg-white/5 border-white/10 text-slate-400 hover:text-white hover:bg-white/10"
                  }`}>
                  {ICONS[t]} {t}
                  {checklists[t]?.length > 0 && (
                    <span className="bg-white/20 rounded-full px-2 py-0.5 text-xs">
                      {checklists[t].filter(i => i.status === "finalizat").length}/{checklists[t].length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Data preview for active tab */}
            {tabData.length > 0 && (
              <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-4 overflow-x-auto">
                <p className="text-slate-400 text-xs mb-2 font-medium uppercase tracking-wider">Preview date — {activeTab} ({tabData.length} rânduri)</p>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 border-b border-white/10">
                      {["Query/Pagină","Clicks","Impresii","CTR","Poziție"].map(h => <th key={h} className="text-left py-1 pr-4 font-medium">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {tabData.slice(0,5).map((r, i) => (
                      <tr key={i} className="border-b border-white/5 text-slate-300">
                        <td className="py-1.5 pr-4 max-w-48 truncate">{r.query || r.page || "—"}</td>
                        <td className="py-1.5 pr-4">{r.clicks}</td>
                        <td className="py-1.5 pr-4">{r.impressions}</td>
                        <td className="py-1.5 pr-4">{r.ctr?.toFixed(1)}%</td>
                        <td className="py-1.5 pr-4">{r.position?.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {tabData.length > 5 && <p className="text-slate-600 text-xs mt-2">+ încă {tabData.length - 5} rânduri trimise la AI</p>}
              </div>
            )}

            <button onClick={analyze} disabled={loading || !tabData.length}
              className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 disabled:opacity-40 text-white font-semibold py-3 rounded-xl mb-5 transition shadow-lg flex items-center justify-center gap-2">
              {loading ? <><span className="animate-spin">⚙️</span> Analizez cu AI...</> : <>{ICONS[activeTab]} Generează Checklist AI — {activeTab}</>}
            </button>
          </>
        )}

        {/* Checklist */}
        {current.length > 0 && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-white font-bold text-lg">{ICONS[activeTab]} {activeTab}</h2>
                <p className="text-slate-400 text-sm">{done} din {current.length} acțiuni finalizate</p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold text-blue-400">{pct}%</div>
                <button onClick={() => setChecklists(p => ({...p,[activeTab]:[]}))} className="text-slate-500 text-xs hover:text-red-400 transition">🗑 Reset</button>
              </div>
            </div>
            <div className="w-full bg-white/10 rounded-full h-2 mb-5">
              <div className="bg-gradient-to-r from-blue-500 to-blue-300 h-2 rounded-full transition-all" style={{width:pct+"%"}} />
            </div>
            <div className="flex gap-2 mb-5">
              {["Toate","De făcut","Finalizate"].map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`px-3 py-1 rounded-lg text-sm transition ${filter===f?"bg-blue-500 text-white":"bg-white/10 text-slate-400 hover:text-white"}`}>{f}</button>
              ))}
            </div>
            {cats.map(cat => {
              const items = filtered.filter(i => i.categorie === cat);
              if (!items.length) return null;
              return (
                <div key={cat} className="mb-5">
                  <h3 className="text-slate-300 text-xs font-semibold uppercase tracking-widest mb-2 pl-1">{cat}</h3>
                  <div className="space-y-2">
                    {items.map(item => {
                      const realIdx = current.indexOf(item);
                      return (
                        <div key={realIdx} onClick={() => toggle(realIdx)}
                          className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition group ${
                            item.status==="finalizat"?"bg-green-500/10 border-green-500/20 opacity-60":"bg-white/5 border-white/10 hover:bg-white/10"
                          }`}>
                          <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition ${
                            item.status==="finalizat"?"bg-green-500 border-green-500":"border-slate-500 group-hover:border-blue-400"
                          }`}>
                            {item.status==="finalizat"&&<span className="text-white text-xs">✓</span>}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              <span className={`text-white font-medium ${item.status==="finalizat"?"line-through text-slate-400":""}`}>{item.actiune}</span>
                              <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${PRIO_COLOR[item.prioritate]||""}`}>{item.prioritate}</span>
                            </div>
                            <p className="text-slate-300 text-sm mb-2">{item.detalii}</p>
                            {item.pagina && (
                              <a href={item.pagina} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 bg-slate-700/50 hover:bg-slate-700 border border-white/10 rounded-lg px-3 py-1.5 mb-2 transition"
                                onClick={e => e.stopPropagation()}>
                                <span className="text-xs">🔗</span>
                                <span className="text-blue-300 text-xs truncate max-w-64">{item.pagina}</span>
                                <span className="text-slate-500 text-xs">↗</span>
                              </a>
                            )}
                            {item.unde && (
                              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 mb-2">
                                <span className="text-blue-300 text-xs font-semibold">📍 Unde: </span>
                                <span className="text-blue-200 text-xs">{item.unde}</span>
                              </div>
                            )}
                            {item.pasi?.length > 0 && (
                              <div className="bg-white/5 rounded-lg px-3 py-2 space-y-1">
                                <p className="text-slate-400 text-xs font-semibold mb-1">📋 Pași:</p>
                                {item.pasi.map((pas, pi) => (
                                  <div key={pi} className="flex items-start gap-2">
                                    <span className="bg-slate-700 text-slate-300 rounded-full w-4 h-4 flex items-center justify-center text-xs flex-shrink-0 mt-0.5">{pi+1}</span>
                                    <span className="text-slate-300 text-xs">{pas}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
