import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ideApi } from "../../../services/tauri/ide";
import type { SearchResult } from "./types";

interface SearchPanelProps {
  projectDir: string;
  onResultClick: (path: string, line: number) => void;
}

export default function SearchPanel({ projectDir, onResultClick }: SearchPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const doSearch = useCallback(async () => {
    if (!query.trim() || !projectDir) return;
    setSearching(true);
    setError(null);
    setHasSearched(true);
    try {
      const r = await ideApi.searchFiles(projectDir, query.trim());
      setResults(r);
    } catch (e) {
      console.error("Search error:", e);
      setError(typeof e === "string" ? e : (e as Error)?.message || String(e));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query, projectDir]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") doSearch();
  };

  return (
    <div className="search-panel">
      <div className="ide-sidebar-header">
        <span>{t("ide.search") || "Search"}</span>
      </div>
      <input
        type="text"
        placeholder={t("ide.searchPlaceholder") || "Search in files (press Enter)"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {searching && (
        <div style={{ opacity: 0.5, fontSize: 12, padding: "4px 6px" }}>
          {t("common.loading") || "Searching..."}
        </div>
      )}
      {!searching && error && (
        <div style={{ color: "var(--error)", fontSize: 12, padding: "6px 8px", background: "rgba(248,113,113,0.08)", borderRadius: 6, marginBottom: 6 }}>
          {error}
        </div>
      )}
      {!searching && !error && hasSearched && results.length === 0 && query.trim() && (
        <div style={{ opacity: 0.5, fontSize: 12, padding: "4px 6px" }}>
          {t("ide.noResults") || "No results found"}
        </div>
      )}
      {results.map((r, i) => (
        <div
          key={`${r.path}-${r.line}-${i}`}
          className="search-result-item"
          onClick={() => onResultClick(r.path, r.line)}
        >
          <div>
            <span className="search-result-path">{r.path}</span>
            <span className="search-result-line">:{r.line}</span>
          </div>
          <div className="search-result-text">{r.text}</div>
        </div>
      ))}
      {!searching && results.length > 0 && (
        <div style={{ opacity: 0.4, fontSize: 11, marginTop: 8 }}>
          {results.length} {t("ide.resultsFound") || "results"}
        </div>
      )}
    </div>
  );
}
