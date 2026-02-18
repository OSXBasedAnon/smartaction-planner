"use client";

import { useState } from "react";

type SearchInputProps = {
  onItems: (items: Array<{ query: string; qty: number }>) => void;
};

export function SearchInput({ onItems }: SearchInputProps) {
  const [value, setValue] = useState("");

  return (
    <div className="grid">
      <label htmlFor="search">Search text or SKU</label>
      <input
        id="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="MacBook Pro 14 M3, paper towels 2-ply, SKU123..."
      />
      <button
        type="button"
        onClick={() => onItems([{ query: value, qty: 1 }])}
        disabled={!value.trim()}
      >
        Use Search Input
      </button>
    </div>
  );
}
