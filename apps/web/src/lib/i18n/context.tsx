'use client';
/** Lightweight TH/EN language context — th is the default, persisted in localStorage. */
import { createContext, useContext, useEffect, useState } from 'react';
import type { Dictionary } from './dictionary';
import { en } from './en';
import { th } from './th';

export type Lang = 'th' | 'en';
const DICTS: Record<Lang, Dictionary> = { th, en };
const STORAGE_KEY = 'dtw-lang';

interface LanguageState {
  lang: Lang;
  t: Dictionary;
  setLang: (lang: Lang) => void;
}

const Ctx = createContext<LanguageState>({ lang: 'th', t: th, setLang: () => {} });

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('th');

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'th' || stored === 'en') setLangState(stored);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  function setLang(next: Lang) {
    setLangState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }

  return <Ctx.Provider value={{ lang, t: DICTS[lang], setLang }}>{children}</Ctx.Provider>;
}

export function useLanguage(): LanguageState {
  return useContext(Ctx);
}
