"use client";

import { useMemo, useState } from "react";

type CsvRow = {
  query: string;
  qty: number;
};

type CSVUploaderProps = {
  onItems: (items: CsvRow[]) => void;
};

function parseCSV(content: string): CsvRow[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [query, qty] = line.split(",").map((part) => part.trim());
      return {
        query,
        qty: Number.isFinite(Number(qty)) && Number(qty) > 0 ? Number(qty) : 1
      };
    })
    .filter((row) => row.query.length > 0);
}

export function CSVUploader({ onItems }: CSVUploaderProps) {
  const [rows, setRows] = useState<CsvRow[]>([]);

  const preview = useMemo(() => rows.slice(0, 3), [rows]);

  return (
    <div className="grid">
      <label htmlFor="csv">Upload CSV (query,qty)</label>
      <input
        id="csv"
        type="file"
        accept=".csv,text/csv"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const text = await file.text();
          const parsed = parseCSV(text);
          setRows(parsed);
          onItems(parsed);
        }}
      />
      {rows.length > 0 ? (
        <p className="small">Loaded {rows.length} rows. Preview: {preview.map((row) => `${row.query} (x${row.qty})`).join(" | ")}</p>
      ) : null}
    </div>
  );
}
