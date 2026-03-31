import { useState, useEffect, useCallback, useRef, type CSSProperties, type FormEvent } from "react";
import { usePersistedState } from "./hooks/usePersistedState";
import { storageGet, storageSet } from "./lib/appStorage";
import type { AppUser } from "./authTypes";

/**
 * Modèles essayés dans l’ordre (quotas distincts par modèle).
 * gemini-2.0-flash est exclu : souvent « free_tier limit: 0 » sur certains projets.
 * @see https://ai.google.dev/gemini-api/docs/models
 */
const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-2.5-flash",
];

const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const SHORT_DAYS = ["LUN", "MAR", "MER", "JEU", "VEN", "SAM", "DIM"];

function getTodayFrDay(): string {
  const days = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
  return days[new Date().getDay()];
}

function formatFrDate(iso: string): string {
  try {
    return new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function getUserInitials(u: AppUser): string {
  const s = (u.displayName || u.username).trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableQuotaError(status: number, message: string): boolean {
  if (status === 429) return true;
  return /quota|rate limit|RESOURCE_EXHAUSTED|limit:\s*0|free_tier/i.test(message);
}

async function geminiGenerateTextOnce(
  apiKey: string,
  model: string,
  prompt: string
): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.65 },
    }),
  });
  if (!res.ok) {
    let message = "";
    try {
      const j = await res.json();
      message = j?.error?.message ?? JSON.stringify(j).slice(0, 420);
    } catch {
      message = await res.text();
    }
    return { ok: false, status: res.status, message: message || `Erreur HTTP ${res.status}` };
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== "string") return { ok: false, status: 200, message: "Réponse vide du modèle" };
  return { ok: true, text };
}

async function geminiGenerateText(apiKey: string, prompt: string): Promise<string> {
  let lastMessage = "";
  for (const model of GEMINI_MODEL_FALLBACKS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await geminiGenerateTextOnce(apiKey, model, prompt);
      if (r.ok) return r.text;
      lastMessage = r.message;

      const retrySec = r.message.match(/retry in ([\d.]+)\s*s/i);
      if (isRetryableQuotaError(r.status, r.message) && retrySec && attempt === 0) {
        const ms = Math.min(55_000, Math.ceil(parseFloat(retrySec[1]) * 1000) + 500);
        await sleep(ms);
        continue;
      }

      if (isRetryableQuotaError(r.status, r.message)) break;

      if (r.status === 400 || r.status === 401 || r.status === 403) {
        throw new Error(r.message);
      }

      if (r.status === 404 && /not found|NOT_FOUND/i.test(r.message)) break;

      throw new Error(r.message);
    }
  }
  throw new Error(
    `${lastMessage}\n\n` +
      `Aucun modèle disponible avec ton quota actuel.\n` +
      `• Attends 1–2 minutes puis réessaie (fenêtre RPM).\n` +
      `• Crée une nouvelle clé sur aistudio.google.com (nouveau projet = nouveaux quotas).\n` +
      `• Ou active la facturation sur le projet Google Cloud lié à la clé (souvent nécessaire si « limit: 0 » partout).\n` +
      `Doc : ai.google.dev/gemini-api/docs/rate-limits`
  );
}

function smoothBezierPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const cpX = (prev.x + curr.x) / 2;
    d += ` C ${cpX},${prev.y} ${cpX},${curr.y} ${curr.x},${curr.y}`;
  }
  return d;
}

function parseRestSeconds(rest: string): number {
  if (/^\d+s$/.test(rest)) return parseInt(rest);
  const m = rest.match(/^(\d+)min(\d+)?/);
  if (m) return parseInt(m[1]) * 60 + (m[2] ? parseInt(m[2]) : 0);
  return 120;
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);
    osc.start();
    osc.stop(ctx.currentTime + 1.2);
  } catch {}
}

function getNextMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 1 : day === 6 ? 2 : 8 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function computeWeeklyGain(weights: WeightEntry[]): number | null {
  if (weights.length < 2) return null;
  const sorted = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 28);
  const recent = sorted.filter(w => new Date(w.date) >= cutoff);
  const data = recent.length >= 2 ? recent : sorted;
  const days = (new Date(data[data.length - 1].date).getTime() - new Date(data[0].date).getTime()) / 86400000;
  if (days < 1) return null;
  return (data[data.length - 1].kg - data[0].kg) / (days / 7);
}

type NutritionGoal = "bulk" | "cut";

type UserProfile = {
  heightCm: number;
  goal: NutritionGoal;
  age: number;
};

/** TDEE homme, activité modérée (entraînement régulier). */
function mifflinTdeeMale(kg: number, heightCm: number, age: number, activity = 1.55): number {
  const bmr = 10 * kg + 6.25 * heightCm - 5 * age + 5;
  return Math.round(bmr * activity);
}

function computeTarget(
  weeklyGain: number | null,
  currentKg: number | null,
  profile: UserProfile
): { kcal: number; protein: number; reason: string } {
  const kg = currentKg ?? 70;
  const heightCm = profile.heightCm > 0 ? profile.heightCm : 175;
  const age = profile.age > 0 ? profile.age : 28;
  const goal: NutritionGoal = profile.goal === "cut" ? "cut" : "bulk";
  const tdee = mifflinTdeeMale(kg, heightCm, age, 1.55);

  if (goal === "cut") {
    let kcal = tdee - 400;
    let reason = `Sèche · TDEE ~${tdee} kcal (Mifflin) · déficit modéré`;
    if (weeklyGain !== null) {
      if (weeklyGain < -0.55) {
        kcal += 150;
        reason += ` · perte >0,5 kg/sem → +150 kcal`;
      } else if (weeklyGain > 0.12) {
        kcal -= 100;
        reason += ` · encore en surplus → -100 kcal`;
      }
    }
    return {
      kcal: Math.max(1350, Math.round(kcal)),
      protein: Math.round(kg * 2.2),
      reason,
    };
  }

  const BASE = tdee + 200;
  const PROT = Math.round(kg * 3);
  if (weeklyGain === null) return { kcal: BASE, protein: PROT, reason: `Prise de masse · TDEE ~${tdee} kcal — objectifs de base (${heightCm} cm, ${age} ans)` };
  if (weeklyGain < 0)     return { kcal: BASE + 300, protein: PROT + 20, reason: `Perte de ${Math.abs(weeklyGain).toFixed(2)} kg/sem → +300 kcal pour inverser` };
  if (weeklyGain < 0.2)   return { kcal: BASE + 200, protein: PROT + 15, reason: `+${weeklyGain.toFixed(2)} kg/sem insuffisant → +200 kcal` };
  if (weeklyGain < 0.35)  return { kcal: BASE + 100, protein: PROT + 10, reason: `+${weeklyGain.toFixed(2)} kg/sem légèrement faible → +100 kcal` };
  if (weeklyGain <= 0.55) return { kcal: BASE,       protein: PROT,      reason: `+${weeklyGain.toFixed(2)} kg/sem ✓ progression idéale` };
  if (weeklyGain <= 0.75) return { kcal: BASE - 100, protein: PROT,      reason: `+${weeklyGain.toFixed(2)} kg/sem élevée → -100 kcal` };
                          return { kcal: BASE - 200, protein: PROT,      reason: `+${weeklyGain.toFixed(2)} kg/sem trop rapide → -200 kcal` };
}

function formatTimer(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// --- DATA ---

const WEEKLY_SCHEDULE = {
  Lundi: { muscle: "Pectoraux", emoji: "🫁", color: "#FF3B5C" },
  Mardi: { muscle: "Dos", emoji: "🔙", color: "#4DAAFF" },
  Mercredi: { muscle: "Épaules", emoji: "💪", color: "#FFD426" },
  Jeudi: { muscle: "Bras (Biceps/Triceps)", emoji: "🦾", color: "#A07AF5" },
  Vendredi: { muscle: "Jambes", emoji: "🦵", color: "#FF7033" },
  Samedi: { muscle: "Repos complet", emoji: "🛌", color: "#40405A" },
  Dimanche: { muscle: "Repos complet", emoji: "🛌", color: "#40405A" },
};

const WORKOUT_DETAILS = {
  Pectoraux: [
    { name: "Développé couché barre", sets: "4×8-10", rest: "2min", note: "Descends lentement, pousse explosif" },
    { name: "Développé incliné haltères", sets: "4×10-12", rest: "90s", note: "30° d'inclinaison" },
    { name: "Écarté poulie vis-à-vis", sets: "3×12-15", rest: "60s", note: "Squeeze en haut" },
    { name: "Pompes (finisher)", sets: "3× max", rest: "60s", note: "Jusqu'à l'échec" },
  ],
  Dos: [
    { name: "Tractions (ou assistées)", sets: "4×6-10", rest: "2min", note: "Prise large, tire avec les coudes" },
    { name: "Rowing barre", sets: "4×8-10", rest: "90s", note: "Dos bien droit, serre les omoplates" },
    { name: "Tirage vertical poulie", sets: "3×10-12", rest: "90s", note: "Prise serrée ou large" },
    { name: "Rowing haltère 1 bras", sets: "3×10-12", rest: "60s", note: "Chaque côté" },
  ],
  Épaules: [
    { name: "Développé militaire barre", sets: "4×8-10", rest: "2min", note: "Debout ou assis" },
    { name: "Élévations latérales", sets: "4×12-15", rest: "60s", note: "Léger, contrôle le mouvement" },
    { name: "Oiseau (rear delt)", sets: "3×12-15", rest: "60s", note: "Penché en avant" },
    { name: "Shrugs haltères", sets: "3×12-15", rest: "60s", note: "Tiens 2s en haut" },
  ],
  "Bras (Biceps/Triceps)": [
    { name: "Curl barre EZ", sets: "4×10-12", rest: "90s", note: "Pas de triche, coudes fixes" },
    { name: "Curl marteau haltères", sets: "3×10-12", rest: "60s", note: "Alternés ou simultanés" },
    { name: "Dips (triceps)", sets: "4×8-12", rest: "90s", note: "Buste droit pour cibler triceps" },
    { name: "Extension poulie haute", sets: "3×12-15", rest: "60s", note: "Corde, écarte en bas" },
  ],
  Jambes: [
    { name: "Squat barre", sets: "4×8-10", rest: "2min30", note: "Descends au moins parallèle" },
    { name: "Presse à cuisses", sets: "4×10-12", rest: "2min", note: "Pieds hauts = + fessiers" },
    { name: "Fentes marchées", sets: "3×12 (chaque)", rest: "90s", note: "Grand pas, genou frôle le sol" },
    { name: "Leg curl allongé", sets: "3×12-15", rest: "60s", note: "Ischio-jambiers" },
    { name: "Mollets debout", sets: "4×15-20", rest: "60s", note: "Amplitude complète" },
  ],
};

const DAILY_ROUTINE = [
  { time: "5h00", label: "Réveil", icon: "⏰" },
  { time: "5h30", label: "Petit-déjeuner", icon: "🍳" },
  { time: "6h00-7h15", label: "Salle de sport", icon: "🏋️" },
  { time: "8h10-9h00", label: "Train → Bureau", icon: "🚆" },
  { time: "10h30", label: "Collation matin", icon: "🍌" },
  { time: "12h30", label: "Déjeuner", icon: "🥗" },
  { time: "16h00", label: "Goûter", icon: "🥜" },
  { time: "17h00", label: "Fin de journée", icon: "🚪" },
  { time: "18h30", label: "Retour maison", icon: "🏠" },
  { time: "19h30", label: "Dîner", icon: "🍽️" },
  { time: "22h00", label: "Coucher", icon: "😴" },
];

const MEAL_PLAN = {
  Lundi: {
    petitDej: { name: "Porridge protéiné", detail: "80g flocons d'avoine + 300ml lait + 200g skyr + 1 banane", kcal: 650, p: 45, g: 15, l: 95 },
    collationAM: { name: "Banane + Skyr", detail: "1 banane + 150g skyr", kcal: 230, p: 18, g: 2, l: 38 },
    dejeuner: { name: "Poulet riz tomate", detail: "250g blanc de poulet + 120g riz (cru) + sauce tomate pulpe", kcal: 650, p: 55, g: 8, l: 80 },
    gouter: { name: "Œufs durs + pomme", detail: "3 œufs durs + 1 pomme", kcal: 310, p: 20, g: 16, l: 22 },
    diner: { name: "Steak haché riz", detail: "200g steak haché 5% + 100g riz + légumes", kcal: 560, p: 48, g: 10, l: 65 },
    total: { kcal: 2400, p: 186, g: 51, l: 300 },
  },
  Mardi: {
    petitDej: { name: "Porridge protéiné", detail: "80g flocons d'avoine + 300ml lait + 200g skyr + 1 banane", kcal: 650, p: 45, g: 15, l: 95 },
    collationAM: { name: "Œufs + banane", detail: "2 œufs durs + 1 banane", kcal: 280, p: 15, g: 12, l: 32 },
    dejeuner: { name: "Thon pâtes tomate", detail: "2 boîtes thon + 120g pâtes + sauce tomate", kcal: 620, p: 52, g: 6, l: 82 },
    gouter: { name: "Skyr + flocons", detail: "200g skyr + 30g flocons d'avoine", kcal: 230, p: 22, g: 3, l: 30 },
    diner: { name: "Poulet riz oignon", detail: "250g poulet + 100g riz + oignon ail tomate", kcal: 620, p: 52, g: 8, l: 72 },
    total: { kcal: 2400, p: 186, g: 44, l: 311 },
  },
  Mercredi: {
    petitDej: { name: "Porridge protéiné", detail: "80g flocons d'avoine + 300ml lait + 200g skyr + 1 banane", kcal: 650, p: 45, g: 15, l: 95 },
    collationAM: { name: "Banane + Skyr", detail: "1 banane + 150g skyr", kcal: 230, p: 18, g: 2, l: 38 },
    dejeuner: { name: "Saumon riz", detail: "250g saumon + 120g riz + concombre/tomate", kcal: 700, p: 50, g: 20, l: 75 },
    gouter: { name: "Œufs + pomme", detail: "3 œufs durs + 1 pomme", kcal: 310, p: 20, g: 16, l: 22 },
    diner: { name: "Steak haché pâtes", detail: "200g steak haché 5% + 120g pâtes + sauce tomate oignon", kcal: 610, p: 50, g: 10, l: 78 },
    total: { kcal: 2500, p: 183, g: 63, l: 308 },
  },
  Jeudi: {
    petitDej: { name: "Porridge protéiné", detail: "80g flocons d'avoine + 300ml lait + 200g skyr + 1 banane", kcal: 650, p: 45, g: 15, l: 95 },
    collationAM: { name: "Œufs + banane", detail: "2 œufs durs + 1 banane", kcal: 280, p: 15, g: 12, l: 32 },
    dejeuner: { name: "Poulet pâtes tomate", detail: "250g poulet + 120g pâtes + pulpe tomate ail", kcal: 650, p: 55, g: 8, l: 82 },
    gouter: { name: "Skyr + flocons", detail: "200g skyr + 30g flocons + 1 pomme", kcal: 300, p: 22, g: 3, l: 48 },
    diner: { name: "Omelette 4 œufs + riz", detail: "4 œufs + oignon + 100g riz", kcal: 540, p: 32, g: 22, l: 55 },
    total: { kcal: 2420, p: 169, g: 60, l: 312 },
  },
  Vendredi: {
    petitDej: { name: "Porridge protéiné", detail: "80g flocons d'avoine + 300ml lait + 200g skyr + 1 banane", kcal: 650, p: 45, g: 15, l: 95 },
    collationAM: { name: "Banane + Skyr", detail: "1 banane + 150g skyr", kcal: 230, p: 18, g: 2, l: 38 },
    dejeuner: { name: "Thon riz tomate", detail: "2 boîtes thon + 120g riz + sauce tomate", kcal: 620, p: 52, g: 6, l: 80 },
    gouter: { name: "Œufs + pomme", detail: "2 œufs durs + 1 pomme", kcal: 230, p: 14, g: 11, l: 22 },
    diner: { name: "Saumon pâtes", detail: "250g saumon + 120g pâtes", kcal: 700, p: 48, g: 20, l: 78 },
    total: { kcal: 2430, p: 177, g: 54, l: 313 },
  },
  Samedi: {
    petitDej: { name: "Porridge + œufs", detail: "80g flocons + 300ml lait + 3 œufs brouillés + 1 banane", kcal: 700, p: 40, g: 25, l: 85 },
    collationAM: { name: "Skyr + pomme", detail: "200g skyr + 1 pomme", kcal: 220, p: 20, g: 2, l: 32 },
    dejeuner: { name: "Steak haché riz", detail: "250g steak haché + 120g riz + sauce tomate oignon", kcal: 650, p: 52, g: 12, l: 75 },
    gouter: { name: "Banane + flocons", detail: "1 banane + 30g flocons + lait", kcal: 250, p: 10, g: 5, l: 42 },
    diner: { name: "Poulet pâtes", detail: "250g poulet + 120g pâtes + tomate", kcal: 620, p: 55, g: 8, l: 78 },
    total: { kcal: 2440, p: 177, g: 52, l: 312 },
  },
  Dimanche: {
    petitDej: { name: "Porridge protéiné", detail: "80g flocons d'avoine + 300ml lait + 200g skyr + 1 banane", kcal: 650, p: 45, g: 15, l: 95 },
    collationAM: { name: "Œufs + pomme", detail: "2 œufs durs + 1 pomme", kcal: 230, p: 14, g: 11, l: 22 },
    dejeuner: { name: "Poulet riz oignon", detail: "250g poulet + 120g riz + oignon tomate", kcal: 650, p: 55, g: 8, l: 78 },
    gouter: { name: "Skyr + banane", detail: "200g skyr + 1 banane", kcal: 250, p: 20, g: 2, l: 38 },
    diner: { name: "Omelette + pâtes", detail: "4 œufs + 100g pâtes + tomate", kcal: 560, p: 32, g: 20, l: 60 },
    total: { kcal: 2340, p: 166, g: 56, l: 293 },
  },
};

const MEAL_LABELS = {
  petitDej: { label: "Petit-déj", icon: "🌅", time: "5h30" },
  collationAM: { label: "Collation", icon: "🍌", time: "10h30" },
  dejeuner: { label: "Déjeuner", icon: "🥗", time: "12h30" },
  gouter: { label: "Goûter", icon: "🥜", time: "16h00" },
  diner: { label: "Dîner", icon: "🍽️", time: "19h30" },
};

const COOKING_PLAN = {
  "Lundi soir": {
    label: "Cuisine ce soir (Lundi + Mardi + Mercredi midi)",
    tasks: [
      "Cuire 500g de blanc de poulet (grillé, assaisonné ail)",
      "Cuire 400g de steak haché 5%",
      "Cuire 600g de riz basmati (poids cru)",
      "Préparer sauce tomate maison : pulpe tomate + oignon + ail",
      "Cuire 6 œufs durs",
      "Portionner dans des tupperwares pour Lun soir, Mar midi, Mar soir, Mer midi",
    ],
  },
  Mercredi: {
    label: "Cuisine Mercredi soir (Jeudi → Vendredi)",
    tasks: [
      "Cuire 500g de blanc de poulet",
      "Cuire 250g de saumon (Vendredi soir)",
      "Cuire 500g de pâtes",
      "Cuire 400g de riz",
      "Préparer sauce tomate + oignon + ail",
      "Cuire 8 œufs durs",
      "Portionner pour Jeu midi, Jeu soir, Ven midi, Ven soir",
    ],
  },
  Dimanche: {
    label: "Cuisine Dimanche (Lundi → Mercredi midi) — semaine prochaine",
    tasks: [
      "Courses le Samedi",
      "Cuire les protéines (poulet, steak haché, saumon)",
      "Cuire les féculents (riz, pâtes)",
      "Préparer les sauces",
      "Cuire les œufs durs pour la semaine",
      "Portionner tout dans des tupperwares étiquetés",
    ],
  },
};

const GROCERIES = [
  { item: "Blanc de poulet", qty: "2 kg", cat: "Protéines", icon: "🍗" },
  { item: "Steak haché 5%", qty: "2 kg", cat: "Protéines", icon: "🥩" },
  { item: "Saumon", qty: "500 g", cat: "Protéines", icon: "🐟" },
  { item: "Thon (conserve)", qty: "4 boîtes", cat: "Protéines", icon: "🥫" },
  { item: "Œufs", qty: "24", cat: "Protéines", icon: "🥚" },
  { item: "Skyr", qty: "2 kg", cat: "Protéines", icon: "🥛" },
  { item: "Lait", qty: "2 L", cat: "Protéines", icon: "🥛" },
  { item: "Flocons d'avoine", qty: "2 kg", cat: "Féculents", icon: "🌾" },
  { item: "Riz basmati", qty: "3 kg", cat: "Féculents", icon: "🍚" },
  { item: "Pâtes", qty: "stock", cat: "Féculents", icon: "🍝" },
  { item: "Bananes", qty: "7", cat: "Fruits/Légumes", icon: "🍌" },
  { item: "Pommes", qty: "6", cat: "Fruits/Légumes", icon: "🍎" },
  { item: "Ail", qty: "4-5 têtes", cat: "Fruits/Légumes", icon: "🧄" },
  { item: "Oignons", qty: "3-4", cat: "Fruits/Légumes", icon: "🧅" },
  { item: "Pulpe de tomate", qty: "4 conserves", cat: "Sauces", icon: "🍅" },
];

/** Prix indicatifs supermarché France (€ pour la quantité listée dans GROCERIES) — pas d’API fiable pour les prix en magasin. */
const GROCERY_ESTIMATE_EUR: Record<string, number> = {
  "Blanc de poulet": 16,
  "Steak haché 5%": 20,
  Saumon: 18,
  "Thon (conserve)": 8,
  Œufs: 7,
  Skyr: 10,
  Lait: 3,
  "Flocons d'avoine": 5,
  "Riz basmati": 9,
  Pâtes: 4,
  Bananes: 3,
  Pommes: 4,
  Ail: 3,
  Oignons: 2,
  "Pulpe de tomate": 5,
};

function estimateGroceryTotal(): { total: number; lines: { item: string; eur: number }[] } {
  const lines = GROCERIES.map((g) => ({ item: g.item, eur: GROCERY_ESTIMATE_EUR[g.item] ?? 0 }));
  const total = Math.round(lines.reduce((s, l) => s + l.eur, 0) * 100) / 100;
  return { total, lines };
}

const GROCERY_DONE_KEY = "muscu-grocery-done";

function useGroceryDone() {
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await storageGet(GROCERY_DONE_KEY);
        if (!cancelled && raw) setDone(JSON.parse(raw));
      } catch {
        /* ignore */
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    storageSet(GROCERY_DONE_KEY, JSON.stringify(done)).catch(() => {});
  }, [done, hydrated]);

  const toggle = useCallback((item: string) => {
    setDone((prev) => ({ ...prev, [item]: !prev[item] }));
  }, []);

  const resetAll = useCallback(() => {
    setDone({});
  }, []);

  return { done, toggle, resetAll };
}

const WEIGHT_STORAGE_KEY = "muscu-weight-data";

type WeightEntry = { date: string; kg: number };
type SetLog = { kg: number; reps: number };
type ExoLog = { date: string; muscle: string; exercise: string; sets: SetLog[] };
type MealEntry = { name: string; detail: string; kcal: number; p: number; g: number; l: number };
type GeneratedPlanDay = {
  petitDej: MealEntry; collationAM: MealEntry; dejeuner: MealEntry; gouter: MealEntry; diner: MealEntry;
  total: { kcal: number; p: number; g: number; l: number };
};
type GeneratedPlan = {
  weekStart: string; generatedAt: string; calorieTarget: number; proteinTarget: number;
  adjustment: string; days: Record<string, GeneratedPlanDay>;
};

type GeneratedPrepSession = { key: string; label: string; tasks: string[] };

type GeneratedPrepPlan = {
  weekStart: string;
  generatedAt: string;
  calorieTarget: number;
  proteinTarget: number;
  goalLabel: string;
  sessions: GeneratedPrepSession[];
  notes?: string;
};

type FoodResult = {
  product_name: string;
  brands: string;
  nutriscore_grade?: string;
  nutriments: {
    "energy-kcal_100g": number;
    proteins_100g: number;
    carbohydrates_100g: number;
    fat_100g: number;
    sugars_100g?: number;
    fiber_100g?: number;
    salt_100g?: number;
  };
};

const useWeightData = () => {
  const [weights, setWeights] = useState<WeightEntry[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await storageGet(WEIGHT_STORAGE_KEY);
        if (!cancelled && raw) setWeights(JSON.parse(raw) as WeightEntry[]);
      } catch {
        /* vide ou JSON invalide */
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    storageSet(WEIGHT_STORAGE_KEY, JSON.stringify(weights)).catch(() => {});
  }, [weights, hydrated]);

  const addWeight = useCallback((date: string, kg: string) => {
    setWeights((prev: WeightEntry[]) =>
      [...prev.filter((w: WeightEntry) => w.date !== date), { date, kg: parseFloat(kg) }].sort((a, b) => a.date.localeCompare(b.date))
    );
  }, []);

  const removeWeight = useCallback((date: string) => {
    setWeights((prev: WeightEntry[]) => prev.filter((w: WeightEntry) => w.date !== date));
  }, []);

  return { weights, addWeight, removeWeight };
};

// --- COMPONENTS ---

const StatCard = ({
  label,
  value,
  unit,
  color,
  hint,
}: {
  label: string;
  value: string;
  unit: string;
  color: string;
  hint?: string;
}) => (
  <div
    className="stat-card"
    style={{
      background: "var(--bg-card)",
      borderRadius: 2,
      padding: "clamp(12px, 3vw, 18px) clamp(12px, 2.8vw, 16px)",
      borderTop: `2px solid ${color}`,
      display: "flex",
      flexDirection: "column",
      gap: 3,
    }}
  >
    <span
      style={{
        fontSize: 9,
        color: "var(--dim)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontFamily: "var(--font-mono)",
        fontWeight: 500,
      }}
    >
      {label}
    </span>
    <span
      style={{
        fontSize: "clamp(1.4rem, 5vw, 1.85rem)",
        fontWeight: 900,
        color,
        fontFamily: "var(--font-display)",
        lineHeight: 1,
        letterSpacing: "-0.01em",
        textTransform: "uppercase",
      }}
    >
      {value}
      <span style={{ fontSize: "0.42em", fontWeight: 600, color: "var(--dim)", marginLeft: 4 }}>{unit}</span>
    </span>
    {hint ? (
      <span style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", marginTop: 3, lineHeight: 1.45 }}>{hint}</span>
    ) : null}
  </div>
);

const MacroBar = ({
  label,
  value,
  max,
  color,
  unit,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  unit: string;
}) => {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div
      className="macro-bar-row"
      role="group"
      aria-label={`${label} : ${value}${unit} sur objectif ${max}`}
    >
      <span
        className="macro-bar-label"
        style={{ width: 76, flexShrink: 0, fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 500 }}
      >
        {label}
      </span>
      <div className="macro-bar-track">
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 0,
            background: color,
            transition: "width 0.55s cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />
      </div>
      <span
        className="macro-bar-value"
        style={{ width: 80, flexShrink: 0, textAlign: "right", fontSize: 11, fontWeight: 600, color, fontFamily: "var(--font-mono)" }}
      >
        {value}{unit}
      </span>
    </div>
  );
};

// --- MAIN APP ---

export default function App(props: { currentUser?: AppUser; onLogout?: () => void } = {}) {
  const { currentUser, onLogout } = props;
  const [activeTab, setActiveTab] = usePersistedState<string>("muscu-tab", "planning");
  const [selectedDay, setSelectedDay] = usePersistedState<string>("muscu-day", getTodayFrDay());
  const [expandedMeal, setExpandedMeal] = useState<string | null>(null);
  const [expandedExo, setExpandedExo] = useState<number | null>(null);
  const { weights, addWeight, removeWeight } = useWeightData();
  const { done: groceryDone, toggle: toggleGrocery, resetAll: resetGroceries } = useGroceryDone();
  const [newDate, setNewDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newKg, setNewKg] = useState("");
  const [weightFormError, setWeightFormError] = useState<string | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const fn = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) setProfileMenuOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [profileMenuOpen]);

  // Timer
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [timerLeft, setTimerLeft] = useState(0);
  const [timerTotal, setTimerTotal] = useState(0);
  const [timerLabel, setTimerLabel] = useState("");

  // Workout log
  const [workoutLog, setWorkoutLog] = usePersistedState<ExoLog[]>("muscu-workout-log", []);
  const [pendingExoSets, setPendingExoSets] = useState<SetLog[]>([]);
  const [logKg, setLogKg] = useState("");
  const [logReps, setLogReps] = useState("");

  // Food search
  const [foodQuery, setFoodQuery] = useState("");
  const [foodResults, setFoodResults] = useState<FoodResult[]>([]);
  const [foodLoading, setFoodLoading] = useState(false);
  const [foodSearched, setFoodSearched] = useState(false);
  const [expandedFood, setExpandedFood] = useState<number | null>(null);
  const [portionGrams, setPortionGrams] = useState("100");
  const [foodFavorites, setFoodFavorites] = usePersistedState<FoodResult[]>("muscu-food-favorites", []);
  const [recentSearches, setRecentSearches] = usePersistedState<string[]>("muscu-food-recent", []);

  const [userProfile, setUserProfile] = usePersistedState<UserProfile>("muscu-profile", {
    heightCm: 180,
    goal: "bulk",
    age: 28,
  });

  // Weekly AI plan (Gemini — quota gratuit via Google AI Studio)
  const [apiKey, setApiKey] = usePersistedState<string>("muscu-gemini-api-key", "");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [generatedPlans, setGeneratedPlans] = usePersistedState<GeneratedPlan[]>("muscu-weekly-plans", []);
  const [selectedPlanIndex, setSelectedPlanIndex] = useState(0);
  const [planGenerating, setPlanGenerating] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [expandedPlanDay, setExpandedPlanDay] = useState<string | null>(null);
  const autoGenDoneRef = useRef(false);

  const [prepPlans, setPrepPlans] = usePersistedState<GeneratedPrepPlan[]>("muscu-prep-plans", []);
  const [selectedPrepIndex, setSelectedPrepIndex] = useState(0);
  const [prepGenerating, setPrepGenerating] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);

  // Edit saved set
  const [editingSet, setEditingSet] = useState<{ exercise: string; date: string; idx: number } | null>(null);
  const [editSetKg, setEditSetKg] = useState("");
  const [editSetReps, setEditSetReps] = useState("");

  const latestWeight = weights.length > 0 ? weights[weights.length - 1] : null;
  const groceryChecked = GROCERIES.filter((g) => groceryDone[g.item]).length;
  const heightM = userProfile.heightCm / 100;
  const imc = latestWeight && heightM > 0 ? latestWeight.kg / (heightM * heightM) : null;
  const groceryEstimate = estimateGroceryTotal();
  const todayStr = new Date().toISOString().slice(0, 10);

  const tabs = [
    { id: "planning", label: "Planning", icon: "📅" },
    { id: "hebdo", label: "Hebdo", icon: "🔄" },
    { id: "nutrition", label: "Nutrition", icon: "🥗" },
    { id: "training", label: "Muscu", icon: "🏋️" },
    { id: "mealprep", label: "Prep", icon: "🍳" },
    { id: "suivi", label: "Suivi", icon: "📈" },
    { id: "aliments", label: "Aliments", icon: "🔍" },
  ];

  const daySchedule = WEEKLY_SCHEDULE[selectedDay as keyof typeof WEEKLY_SCHEDULE];
  const dayMeals = MEAL_PLAN[selectedDay as keyof typeof MEAL_PLAN];

  const selectDay = (d: string) => {
    setSelectedDay(d);
    setExpandedMeal(null);
    setExpandedExo(null);
  };

  const submitWeight = (e: FormEvent) => {
    e.preventDefault();
    setWeightFormError(null);
    const kgNum = parseFloat(newKg.replace(",", "."));
    if (!newDate.trim()) { setWeightFormError("Choisis une date."); return; }
    if (!newKg.trim() || Number.isNaN(kgNum)) { setWeightFormError("Entre un poids valide."); return; }
    if (kgNum < 35 || kgNum > 220) { setWeightFormError("Poids hors plage (35–220 kg)."); return; }
    addWeight(newDate, String(kgNum));
    setNewKg("");
  };

  const weeklyGain = computeWeeklyGain(weights);
  const targetData = computeTarget(weeklyGain, latestWeight?.kg ?? null, userProfile);

  const generateWeeklyPlan = async (weekStart?: string) => {
    if (!apiKey) return;
    const wStart = weekStart ?? getNextMonday();
    setPlanGenerating(true);
    setPlanError(null);
    setExpandedPlanDay(null);

    const weightHistory = [...weights].sort((a, b) => a.date.localeCompare(b.date))
      .slice(-16).map(w => `${w.date}: ${w.kg}kg`).join(", ") || "Aucune pesée enregistrée";
    const totalGain = weights.length >= 2
      ? `+${(weights[weights.length - 1].kg - weights[0].kg).toFixed(1)}kg depuis le début`
      : "départ non enregistré";

    const goalFr = userProfile.goal === "cut" ? "sèche (déficit calorique, protéines élevées)" : "prise de masse propre (surplus modéré)";
    const prompt = `Tu es un expert en nutrition sportive.

Profil athlète: ${latestWeight?.kg ?? 70} kg, ${userProfile.heightCm} cm, ${userProfile.age} ans, objectif: ${goalFr}
Semaine à planifier: du ${wStart}
Historique poids: ${weightHistory}
Bilan: ${totalGain}
Évolution récente: ${weeklyGain !== null ? `${weeklyGain > 0 ? "+" : ""}${weeklyGain.toFixed(2)} kg/semaine` : "données insuffisantes"}
Cible cette semaine: ${targetData.kcal} kcal/jour · ${targetData.protein}g protéines/jour
Raison: ${targetData.reason}

Génère un plan repas complet pour 7 jours (Lundi à Dimanche).
Contraintes: aliments simples et économiques uniquement (poulet, riz, pâtes, œufs, thon, saumon, steak haché 5%, skyr, flocons d'avoine, légumes, fruits).
${userProfile.goal === "cut" ? "Privilégie satiété et protéines ; glucides modérés autour de l'entraînement." : "Varie les protéines d'un jour à l'autre."}
Varie les repas d'un jour à l'autre et adapte les portions pour atteindre la cible calorique.

Retourne UNIQUEMENT un JSON valide sans texte autour:
{
  "adjustment": "${targetData.reason}",
  "calorieTarget": ${targetData.kcal},
  "proteinTarget": ${targetData.protein},
  "Lundi": {
    "petitDej": {"name":"Porridge protéiné","detail":"80g flocons + 300ml lait + 200g skyr + 1 banane","kcal":650,"p":45,"g":95,"l":15},
    "collationAM": {"name":"...","detail":"...","kcal":230,"p":18,"g":38,"l":2},
    "dejeuner": {"name":"...","detail":"...","kcal":650,"p":55,"g":80,"l":8},
    "gouter": {"name":"...","detail":"...","kcal":310,"p":20,"g":22,"l":16},
    "diner": {"name":"...","detail":"...","kcal":560,"p":48,"g":65,"l":10},
    "total": {"kcal":${targetData.kcal},"p":${targetData.protein},"g":300,"l":51}
  },
  "Mardi": {...},
  "Mercredi": {...},
  "Jeudi": {...},
  "Vendredi": {...},
  "Samedi": {...},
  "Dimanche": {...}
}`;

    try {
      const text = await geminiGenerateText(apiKey, prompt);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Réponse invalide du modèle");
      const parsed = JSON.parse(jsonMatch[0]);
      const plan: GeneratedPlan = {
        weekStart: wStart,
        generatedAt: new Date().toISOString(),
        calorieTarget: parsed.calorieTarget ?? targetData.kcal,
        proteinTarget: parsed.proteinTarget ?? targetData.protein,
        adjustment: parsed.adjustment ?? targetData.reason,
        days: { Lundi: parsed.Lundi, Mardi: parsed.Mardi, Mercredi: parsed.Mercredi, Jeudi: parsed.Jeudi, Vendredi: parsed.Vendredi, Samedi: parsed.Samedi, Dimanche: parsed.Dimanche },
      };
      setGeneratedPlans((prev) => [plan, ...prev.filter((p) => p.weekStart !== wStart)].slice(0, 104));
      setSelectedPlanIndex(0);
    } catch (e: any) {
      setPlanError(e?.message ?? "Erreur inconnue");
    }
    setPlanGenerating(false);
  };

  const generatePrepWeeklyPlan = async (weekStart?: string) => {
    if (!apiKey) return;
    const wStart = weekStart ?? getNextMonday();
    setPrepGenerating(true);
    setPrepError(null);

    const goalFr = userProfile.goal === "cut" ? "sèche" : "prise de masse";
    const latestWeekPlan = generatedPlans.find((p) => p.weekStart === wStart) ?? generatedPlans[0];
    const weekMealsContext = latestWeekPlan
      ? JSON.stringify(latestWeekPlan.days).slice(0, 8000)
      : "Aucun plan hebdo JSON encore — base-toi sur les cibles macros uniquement.";

    const prompt = `Tu es coach en meal prep (batch cooking) pour sportif.

Profil: ${latestWeight?.kg ?? 70} kg, ${userProfile.heightCm} cm, ${userProfile.age} ans, objectif ${goalFr}.
Cibles nutrition: ${targetData.kcal} kcal/jour, ${targetData.protein} g protéines/jour.
Semaine à couvrir: à partir du ${wStart}.

Plan repas 7 jours (référence, peut être incomplet):
${weekMealsContext}

Tâche: génère un plan de préparation culinaire sur la semaine (sessions de batch type "Lundi soir", "Mercredi soir", "Dimanche") avec quantités en grammes cuits, cuissons, sauces, œufs durs, portionnement. Les tâches doivent être actionnables en cuisine.

Retourne UNIQUEMENT un JSON valide sans markdown:
{
  "notes": "une phrase optionnelle",
  "sessions": [
    { "key": "Lundi soir", "label": "Titre court", "tasks": ["tâche 1", "tâche 2"] }
  ]
}
Minimum 3 sessions, maximum 5. Clés "key" en français (ex: Lundi soir, Mercredi, Dimanche).`;

    try {
      const text = await geminiGenerateText(apiKey, prompt);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Réponse invalide du modèle");
      const parsed = JSON.parse(jsonMatch[0]);
      const sessions = (parsed.sessions || []) as GeneratedPrepSession[];
      if (!Array.isArray(sessions) || sessions.length === 0) throw new Error("Aucune session de prep dans la réponse");
      const newPrep: GeneratedPrepPlan = {
        weekStart: wStart,
        generatedAt: new Date().toISOString(),
        calorieTarget: targetData.kcal,
        proteinTarget: targetData.protein,
        goalLabel: goalFr,
        sessions,
        notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
      };
      setPrepPlans((prev) => [newPrep, ...prev.filter((p) => p.weekStart !== wStart)].slice(0, 104));
      setSelectedPrepIndex(0);
    } catch (e: any) {
      setPrepError(e?.message ?? "Erreur inconnue");
    }
    setPrepGenerating(false);
  };

  const removeWeeklyPlanAt = useCallback(
    (index: number) => {
      setGeneratedPlans((prev) => {
        const next = prev.filter((_, i) => i !== index);
        setSelectedPlanIndex((sel) => {
          if (next.length === 0) return 0;
          if (index < sel) return sel - 1;
          if (index === sel) return Math.min(sel, next.length - 1);
          return sel;
        });
        setExpandedPlanDay(null);
        return next;
      });
    },
    [setGeneratedPlans]
  );

  const removePrepPlanAt = useCallback(
    (index: number) => {
      setPrepPlans((prev) => {
        const next = prev.filter((_, i) => i !== index);
        setSelectedPrepIndex((sel) => {
          if (next.length === 0) return 0;
          if (index < sel) return sel - 1;
          if (index === sel) return Math.min(sel, next.length - 1);
          return sel;
        });
        return next;
      });
    },
    [setPrepPlans]
  );

  // Migration ancienne clé (Anthropic) → Gemini si encore présente
  useEffect(() => {
    try {
      const oldRaw = localStorage.getItem("muscu-api-key");
      if (!oldRaw) return;
      const parsed = JSON.parse(oldRaw);
      if (typeof parsed === "string" && parsed.length > 0) {
        setApiKey((prev) => prev || parsed);
        localStorage.removeItem("muscu-api-key");
      }
    } catch {
      /* ignore */
    }
  }, [setApiKey]);

  // Migration ancien prep unique → liste
  useEffect(() => {
    try {
      if (prepPlans.length > 0) return;
      const raw = localStorage.getItem("muscu-prep-ai");
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p?.weekStart && Array.isArray(p.sessions)) {
        setPrepPlans([p]);
        localStorage.removeItem("muscu-prep-ai");
      }
    } catch {
      /* ignore */
    }
  }, [prepPlans.length, setPrepPlans]);

  useEffect(() => {
    if (selectedPlanIndex >= generatedPlans.length && generatedPlans.length > 0) {
      setSelectedPlanIndex(generatedPlans.length - 1);
    }
  }, [generatedPlans.length, selectedPlanIndex]);

  useEffect(() => {
    if (selectedPrepIndex >= prepPlans.length && prepPlans.length > 0) {
      setSelectedPrepIndex(prepPlans.length - 1);
    }
  }, [prepPlans.length, selectedPrepIndex]);

  // Auto-generate every Saturday for the coming week
  useEffect(() => {
    if (autoGenDoneRef.current || !apiKey) return;
    const today = new Date();
    if (today.getDay() !== 6) return; // Saturday only
    const nextMon = getNextMonday();
    if (generatedPlans.some(p => p.weekStart === nextMon)) return;
    autoGenDoneRef.current = true;
    generateWeeklyPlan(nextMon);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, weights.length]);

  const startTimer = (secs: number, label: string) => {
    if (timerRef.current) clearInterval(timerRef.current);
    setTimerLeft(secs);
    setTimerTotal(secs);
    setTimerLabel(label);
    timerRef.current = setInterval(() => {
      setTimerLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          playBeep();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setTimerLeft(0);
    setTimerTotal(0);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const searchFood = async (query?: string) => {
    const q = (query ?? foodQuery).trim();
    if (!q) return;
    if (query) setFoodQuery(query);
    setFoodLoading(true);
    setFoodSearched(true);
    setFoodResults([]);
    setExpandedFood(null);
    setPortionGrams("100");
    try {
      const res = await fetch(
        `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=12&lc=fr&fields=product_name,nutriments,brands,nutriscore_grade`
      );
      const data = await res.json();
      const results = (data.products || []).filter(
        (p: FoodResult) => p.product_name && p.nutriments?.["energy-kcal_100g"]
      );
      setFoodResults(results);
      if (results.length > 0) {
        setRecentSearches((prev) => [q, ...prev.filter((s) => s !== q)].slice(0, 5));
      }
    } catch {
      setFoodResults([]);
    }
    setFoodLoading(false);
  };

  const toggleFoodFavorite = (food: FoodResult) => {
    setFoodFavorites((prev) => {
      const exists = prev.some((f) => f.product_name === food.product_name && f.brands === food.brands);
      return exists ? prev.filter((f) => !(f.product_name === food.product_name && f.brands === food.brands)) : [food, ...prev];
    });
  };

  const isFoodFavorite = (food: FoodResult) =>
    foodFavorites.some((f) => f.product_name === food.product_name && f.brands === food.brands);

  const NUTRISCORE_COLOR: Record<string, string> = { a: "#00AF00", b: "#85BB2F", c: "#FFCC00", d: "#FF6600", e: "#FF2D00" };

  const addPendingSet = () => {
    const kg = parseFloat(logKg.replace(",", "."));
    const reps = parseInt(logReps);
    if (!isNaN(kg) && !isNaN(reps) && kg > 0 && reps > 0) {
      setPendingExoSets((prev) => [...prev, { kg, reps }]);
      setLogKg("");
      setLogReps("");
    }
  };

  const savePendingSession = (exoName: string) => {
    if (pendingExoSets.length === 0) return;
    setWorkoutLog((prev) => {
      const filtered = prev.filter((e) => !(e.exercise === exoName && e.date === todayStr));
      return [...filtered, { date: todayStr, muscle: daySchedule.muscle, exercise: exoName, sets: pendingExoSets }];
    });
    setPendingExoSets([]);
  };

  const openExo = (i: number | null) => {
    setExpandedExo(i);
    setPendingExoSets([]);
    setLogKg("");
    setLogReps("");
    setEditingSet(null);
  };

  const startEditSet = (exercise: string, date: string, idx: number, kg: number, reps: number) => {
    setEditingSet({ exercise, date, idx });
    setEditSetKg(String(kg));
    setEditSetReps(String(reps));
  };

  const saveEditSet = () => {
    if (!editingSet) return;
    const kg = parseFloat(editSetKg.replace(",", "."));
    const reps = parseInt(editSetReps);
    if (isNaN(kg) || isNaN(reps) || kg <= 0 || reps <= 0) return;
    setWorkoutLog((prev) =>
      prev.map((e) =>
        e.exercise === editingSet.exercise && e.date === editingSet.date
          ? { ...e, sets: e.sets.map((s, i) => (i === editingSet.idx ? { kg, reps } : s)) }
          : e
      )
    );
    setEditingSet(null);
  };

  const deleteSetFromLog = (exercise: string, date: string, idx: number) => {
    setWorkoutLog((prev) =>
      prev
        .map((e) =>
          e.exercise === exercise && e.date === date
            ? { ...e, sets: e.sets.filter((_, i) => i !== idx) }
            : e
        )
        .filter((e) => e.sets.length > 0)
    );
    if (editingSet?.exercise === exercise && editingSet?.date === date && editingSet?.idx === idx) {
      setEditingSet(null);
    }
  };

  const deleteSession = (exercise: string, date: string) => {
    setWorkoutLog((prev) => prev.filter((e) => !(e.exercise === exercise && e.date === date)));
    setEditingSet(null);
  };

  const deletePendingSet = (idx: number) => {
    setPendingExoSets((prev) => prev.filter((_, i) => i !== idx));
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 2,
    border: "1px solid var(--border)",
    borderBottom: "2px solid var(--dim)",
    background: "var(--bg)",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    outline: "none",
    transition: "border-color 0.15s",
  };

  return (
    <div
      className="app-shell"
      style={{
        "--bg": "#0A0A0E",
        "--bg-card": "#10101A",
        "--bg-raised": "#17172A",
        "--bg-dim": "rgba(255,255,255,0.05)",
        "--text": "#E4E4F0",
        "--dim": "#8080A8",
        "--border": "rgba(255,255,255,0.07)",
        "--accent": "#BEFF00",
        "--accent2": "#4DAAFF",
        "--accent3": "#FF3B5C",
        "--accent4": "#A07AF5",
        "--font-display": "'Barlow Condensed', sans-serif",
        "--font-body": "'Barlow', sans-serif",
        "--font-mono": "'IBM Plex Mono', monospace",
        fontFamily: "var(--font-body)",
        color: "var(--text)",
        background: "radial-gradient(ellipse 80% 35% at 50% 0%, rgba(190,255,0,0.04), transparent 55%), var(--bg)",
        minHeight: "100vh",
      } as CSSProperties}
    >
      {/* HEADER */}
      <header
        className="app-header"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: "rgba(10,10,14,0.96)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          borderBottom: "1px solid rgba(190,255,0,0.08)",
          marginLeft: "calc(-1 * var(--layout-pad-x))",
          marginRight: "calc(-1 * var(--layout-pad-x))",
          paddingLeft: "var(--layout-pad-x)",
          paddingRight: "var(--layout-pad-x)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
            <h1
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "clamp(1.9rem, 6.5vw, 3.4rem)",
                fontWeight: 900,
                color: "var(--text)",
                letterSpacing: "-0.02em",
                lineHeight: 1,
                margin: 0,
                textTransform: "uppercase",
              }}
            >
              MASS PROTOCOL
            </h1>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                color: "var(--accent)",
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                paddingBottom: 5,
                fontWeight: 500,
              }}
            >
              V1.0
            </span>
          </div>
          {currentUser && onLogout ? (
            <div ref={profileMenuRef} style={{ position: "relative", paddingBottom: 2, flexShrink: 0 }}>
              <button
                type="button"
                aria-expanded={profileMenuOpen}
                aria-haspopup="menu"
                onClick={() => setProfileMenuOpen((o) => !o)}
                title={currentUser.displayName || currentUser.username}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  border: "2px solid rgba(190,255,0,0.35)",
                  background: "linear-gradient(145deg, #2a2a38, #17172A)",
                  color: "var(--accent)",
                  fontFamily: "var(--font-display)",
                  fontSize: 14,
                  fontWeight: 800,
                  cursor: "pointer",
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  letterSpacing: "-0.02em",
                }}
              >
                {getUserInitials(currentUser)}
              </button>
              {profileMenuOpen ? (
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    right: 0,
                    minWidth: 180,
                    background: "var(--bg-raised)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
                    padding: "6px 0",
                    zIndex: 100,
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      setProfileModalOpen(true);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 14px",
                      border: "none",
                      background: "transparent",
                      color: "var(--text)",
                      fontFamily: "var(--font-body)",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    Profil
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      void onLogout();
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 14px",
                      border: "none",
                      background: "transparent",
                      color: "var(--accent3)",
                      fontFamily: "var(--font-body)",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    Déconnexion
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--dim)",
            margin: "5px 0 0",
            letterSpacing: "0.09em",
            textTransform: "uppercase",
          }}
        >
          ECTOMORPHE · 60 KG · PRISE DE MASSE · PLANNING + NUTRITION + SUIVI
        </p>
      </header>

      {profileModalOpen && currentUser ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-modal-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
          onClick={() => setProfileModalOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-raised)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: 24,
              maxWidth: 380,
              width: "100%",
              boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
            }}
          >
            <h2 id="profile-modal-title" style={{ margin: "0 0 18px", fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 800 }}>
              Profil
            </h2>
            <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Nom affiché
            </p>
            <p style={{ margin: "0 0 16px", fontSize: 15 }}>{currentUser.displayName || currentUser.username}</p>
            <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Identifiant
            </p>
            <p style={{ margin: "0 0 22px", fontSize: 15 }}>{currentUser.username}</p>
            <button
              type="button"
              onClick={() => setProfileModalOpen(false)}
              style={{
                padding: "10px 18px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                background: "var(--bg-dim)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                cursor: "pointer",
                borderRadius: 2,
                fontWeight: 600,
              }}
            >
              Fermer
            </button>
          </div>
        </div>
      ) : null}

      <div className="app-layout">
        <aside className="app-layout-sidebar" aria-label="Indicateurs">
          <div className="app-stats-grid">
            <StatCard
              label="Poids suivi"
              value={latestWeight ? latestWeight.kg.toFixed(1) : "—"}
              unit={latestWeight ? "kg" : ""}
              color="#BEFF00"
              hint={latestWeight ? `Pesée : ${formatFrDate(latestWeight.date)}` : "Ajoute une pesée → Suivi"}
            />
            <StatCard
              label="Taille"
              value={(userProfile.heightCm / 100).toFixed(2)}
              unit="m"
              color="#4DAAFF"
              hint="Réglage onglet Hebdo"
            />
            <StatCard
              label="IMC"
              value={imc ? imc.toFixed(1) : "—"}
              unit=""
              color="#FF7033"
              hint={imc ? (imc < 18.5 ? "Sous-poids" : imc < 25 ? "Normal" : "Surpoids") : "Ajoute une pesée"}
            />
            <StatCard
              label="Objectif"
              value={`~${targetData.kcal}`}
              unit="kcal/j"
              color="#FF3B5C"
              hint={userProfile.goal === "cut" ? "Sèche" : "Prise de masse"}
            />
            <StatCard label="Protéines" value={`~${targetData.protein}`} unit="g/j" color="#A07AF5" />
          </div>
        </aside>

        <main className="app-layout-main">
          {/* TAB BAR */}
          <nav className="app-tab-nav" role="tablist" aria-label="Sections">
            {tabs.map((t) => {
              const selected = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="app-tab-btn"
                  onClick={() => setActiveTab(t.id)}
                  style={{
                    background: selected ? "var(--accent)" : "transparent",
                    color: selected ? "#0A0A0E" : "var(--dim)",
                    fontWeight: selected ? 800 : 600,
                  }}
                >
                  <span className="app-tab-icon" aria-hidden>{t.icon}</span>
                  {t.label}
                </button>
              );
            })}
          </nav>

          {/* DAY SELECTOR */}
          {["planning", "nutrition", "training"].includes(activeTab) && (
            <div style={{ marginBottom: "clamp(14px, 3vw, 22px)" }}>
              <div className="app-day-toolbar">
                <span className="app-day-toolbar-hint">Jour actuel</span>
                <button type="button" className="app-today-btn" onClick={() => selectDay(getTodayFrDay())}>
                  Aujourd'hui
                </button>
              </div>
              <div className="app-day-row" role="group" aria-label="Jour de la semaine">
                {DAYS.map((d, i) => {
                  const isActive = selectedDay === d;
                  const sched = WEEKLY_SCHEDULE[d as keyof typeof WEEKLY_SCHEDULE];
                  return (
                    <button
                      key={d}
                      type="button"
                      className="app-day-btn"
                      onClick={() => selectDay(d)}
                      style={{
                        borderTop: "none",
                        borderLeft: "none",
                        borderRight: "none",
                        borderBottom: isActive ? `2px solid ${sched.color}` : "2px solid transparent",
                        background: isActive ? `${sched.color}12` : "transparent",
                        color: isActive ? sched.color : "var(--dim)",
                        fontWeight: isActive ? 600 : 400,
                      }}
                    >
                      <span style={{ fontSize: "clamp(13px, 3.2vw, 17px)" }} aria-hidden>{sched.emoji}</span>
                      {SHORT_DAYS[i]}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ============ PLANNING TAB ============ */}
          {activeTab === "planning" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <div style={{ width: 3, height: 22, background: daySchedule.color, flexShrink: 0 }} />
                <h2
                  className="app-section-title"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 900,
                    margin: 0,
                    color: daySchedule.color,
                    textTransform: "uppercase",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {selectedDay} — {daySchedule.muscle}
                </h2>
              </div>
              <p
                className="app-typo-sub"
                style={{ color: "var(--dim)", margin: "0 0 clamp(14px, 3vw, 22px)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.07em" }}
              >
                {selectedDay === "Samedi" || selectedDay === "Dimanche"
                  ? "Récupération complète"
                  : "Journée type — du réveil au coucher"}
              </p>

              <div style={{ position: "relative", paddingLeft: "clamp(22px, 6vw, 32px)" }}>
                <div
                  style={{
                    position: "absolute",
                    left: "clamp(6px, 2vw, 10px)",
                    top: 0,
                    bottom: 0,
                    width: 1,
                    background: "rgba(190,255,0,0.12)",
                  }}
                />
                {DAILY_ROUTINE.map((item, i) => (
                  <div key={i} style={{ position: "relative", marginBottom: 10, display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div
                      style={{
                        position: "absolute",
                        left: -22,
                        top: 10,
                        width: 9,
                        height: 9,
                        borderRadius: 1,
                        background: i === 2 ? daySchedule.color : "var(--bg-raised)",
                        border: `1px solid ${i === 2 ? daySchedule.color : "var(--dim)"}`,
                        zIndex: 1,
                      }}
                    />
                    <div
                      style={{
                        background: "var(--bg-card)",
                        borderRadius: 2,
                        padding: "10px 14px",
                        flex: 1,
                        borderLeft: i === 2 ? `2px solid ${daySchedule.color}` : "2px solid transparent",
                        border: "1px solid var(--border)",
                        borderLeftWidth: i === 2 ? 2 : 1,
                        borderLeftColor: i === 2 ? daySchedule.color : "var(--border)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 10,
                            color: "var(--accent)",
                            fontWeight: 600,
                            letterSpacing: "0.06em",
                          }}
                        >
                          {item.time}
                        </span>
                        <span style={{ fontSize: 15 }}>{item.icon}</span>
                      </div>
                      <div
                        style={{
                          fontFamily: "var(--font-display)",
                          fontSize: "clamp(13px, 3vw, 15px)",
                          fontWeight: 800,
                          textTransform: "uppercase",
                          letterSpacing: "0.02em",
                          marginTop: 3,
                        }}
                      >
                        {item.label}
                      </div>
                      {i === 2 && selectedDay !== "Samedi" && selectedDay !== "Dimanche" && (
                        <div
                          style={{
                            fontSize: 9,
                            color: daySchedule.color,
                            marginTop: 4,
                            fontFamily: "var(--font-mono)",
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                          }}
                        >
                          → {daySchedule.muscle}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============ HEBDO (IA) TAB ============ */}
          {activeTab === "hebdo" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "clamp(12px, 3vw, 18px)" }}>
                <div style={{ width: 3, height: 22, background: "var(--accent)", flexShrink: 0 }} />
                <h2
                  className="app-section-title"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 900,
                    margin: 0,
                    textTransform: "uppercase",
                    letterSpacing: "-0.01em",
                  }}
                >
                  Plan hebdo IA
                </h2>
              </div>

              <div
                className="app-card-pad"
                style={{
                  background: "var(--bg-card)",
                  borderRadius: 4,
                  marginBottom: 16,
                  border: "1px solid var(--border)",
                }}
              >
                <p style={{ fontSize: 12, color: "var(--dim)", margin: "0 0 14px", lineHeight: 1.55, fontFamily: "var(--font-body)" }}>
                  Profil utilisé pour le TDEE (Mifflin–St Jeor) et les cibles. IA via{" "}
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent2)" }}>
                    Google AI Studio
                  </a>{" "}
                  (quota gratuit, clé stockée localement sur cet appareil).
                </p>
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Taille (cm)</span>
                    <input
                      type="number"
                      min={140}
                      max={220}
                      value={userProfile.heightCm}
                      onChange={(e) => setUserProfile((p) => ({ ...p, heightCm: Math.min(220, Math.max(140, parseInt(e.target.value, 10) || 170)) }))}
                      style={{
                        background: "var(--bg-raised)",
                        border: "1px solid var(--border)",
                        color: "var(--text)",
                        padding: "8px 10px",
                        fontFamily: "var(--font-mono)",
                        fontSize: 13,
                        borderRadius: 2,
                      }}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Âge</span>
                    <input
                      type="number"
                      min={16}
                      max={80}
                      value={userProfile.age}
                      onChange={(e) => setUserProfile((p) => ({ ...p, age: Math.min(80, Math.max(16, parseInt(e.target.value, 10) || 25)) }))}
                      style={{
                        background: "var(--bg-raised)",
                        border: "1px solid var(--border)",
                        color: "var(--text)",
                        padding: "8px 10px",
                        fontFamily: "var(--font-mono)",
                        fontSize: 13,
                        borderRadius: 2,
                      }}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>
                    <span style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Objectif</span>
                    <select
                      value={userProfile.goal}
                      onChange={(e) => setUserProfile((p) => ({ ...p, goal: e.target.value as NutritionGoal }))}
                      style={{
                        background: "var(--bg-raised)",
                        border: "1px solid var(--border)",
                        color: "var(--text)",
                        padding: "8px 10px",
                        fontFamily: "var(--font-body)",
                        fontSize: 13,
                        borderRadius: 2,
                        maxWidth: 280,
                      }}
                    >
                      <option value="bulk">Prise de masse</option>
                      <option value="cut">Sèche</option>
                    </select>
                  </label>
                </div>
                <div style={{ marginTop: 14 }}>
                  <span style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Clé API Google (Gemini)</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6, alignItems: "center" }}>
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="AIza..."
                      value={apiKeyInput || apiKey}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      style={{
                        flex: "1 1 200px",
                        minWidth: 0,
                        background: "var(--bg-raised)",
                        border: "1px solid var(--border)",
                        color: "var(--text)",
                        padding: "8px 10px",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        borderRadius: 2,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setApiKey(apiKeyInput.trim());
                        setApiKeyInput("");
                      }}
                      style={{
                        padding: "8px 14px",
                        borderRadius: 2,
                        border: "none",
                        background: "var(--accent)",
                        color: "#0A0A0E",
                        fontWeight: 800,
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        cursor: "pointer",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      Enregistrer
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    marginTop: 14,
                    padding: "10px 12px",
                    background: "rgba(190,255,0,0.06)",
                    border: "1px solid rgba(190,255,0,0.12)",
                    borderRadius: 2,
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: "var(--accent)",
                    lineHeight: 1.5,
                  }}
                >
                  Cible actuelle: {targetData.kcal} kcal/j · {targetData.protein} g prot/j — {targetData.reason}
                </div>
                <button
                  type="button"
                  disabled={!apiKey || planGenerating}
                  onClick={() => generateWeeklyPlan()}
                  style={{
                    marginTop: 14,
                    padding: "12px 18px",
                    borderRadius: 2,
                    border: "none",
                    background: apiKey && !planGenerating ? "var(--accent2)" : "var(--border)",
                    color: apiKey && !planGenerating ? "#0A0A0E" : "var(--dim)",
                    fontWeight: 800,
                    fontFamily: "var(--font-display)",
                    fontSize: 13,
                    cursor: apiKey && !planGenerating ? "pointer" : "not-allowed",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    width: "100%",
                  }}
                >
                  {planGenerating ? "Génération…" : "Générer le plan repas 7 jours"}
                </button>
                {planError ? (
                  <p style={{ color: "#FF3B5C", fontSize: 12, marginTop: 10, fontFamily: "var(--font-mono)" }}>{planError}</p>
                ) : null}
              </div>

              {generatedPlans.length > 0 ? (
                <div>
                  <h3
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: "clamp(15px, 3.5vw, 18px)",
                      fontWeight: 800,
                      margin: "0 0 8px",
                      textTransform: "uppercase",
                      letterSpacing: "0.02em",
                    }}
                  >
                    Historique des semaines ({generatedPlans.length})
                  </h3>
                  <p style={{ fontSize: 11, color: "var(--dim)", margin: "0 0 12px", lineHeight: 1.5 }}>
                    Chaque nouvelle génération est ajoutée ; les semaines précédentes restent consultables (jusqu’à ~2 ans stockées localement).
                  </p>
                  {generatedPlans.length > 1 ? (
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                      <span style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        Voir une semaine
                      </span>
                      <select
                        value={Math.min(selectedPlanIndex, generatedPlans.length - 1)}
                        onChange={(e) => {
                          setSelectedPlanIndex(Number(e.target.value));
                          setExpandedPlanDay(null);
                        }}
                        style={{
                          background: "var(--bg-raised)",
                          border: "1px solid var(--border)",
                          color: "var(--text)",
                          padding: "10px 12px",
                          fontFamily: "var(--font-body)",
                          fontSize: 13,
                          borderRadius: 2,
                          maxWidth: "100%",
                        }}
                      >
                        {generatedPlans.map((p, i) => (
                          <option key={p.weekStart + p.generatedAt} value={i}>
                            Semaine du {formatFrDate(p.weekStart)} — créé le {formatFrDate(p.generatedAt.slice(0, 10))}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {(() => {
                    const planIdx = Math.min(selectedPlanIndex, generatedPlans.length - 1);
                    const plan = generatedPlans[planIdx];
                    if (!plan) return null;
                    return (
                      <div
                        key={plan.weekStart + plan.generatedAt}
                        className="app-card-pad"
                        style={{
                          background: "var(--bg-card)",
                          borderRadius: 4,
                          marginBottom: 12,
                          border: "1px solid var(--border)",
                          borderLeft: "2px solid var(--accent2)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: 10,
                            marginBottom: 8,
                          }}
                        >
                          <div style={{ fontSize: 10, color: "var(--dim)", fontFamily: "var(--font-mono)", flex: "1 1 200px" }}>
                            Semaine du {formatFrDate(plan.weekStart)} · généré {formatFrDate(plan.generatedAt.slice(0, 10))}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm("Supprimer cette génération de l’historique ?")) removeWeeklyPlanAt(planIdx);
                            }}
                            style={{
                              flexShrink: 0,
                              padding: "6px 12px",
                              fontSize: 10,
                              fontFamily: "var(--font-mono)",
                              textTransform: "uppercase",
                              letterSpacing: "0.06em",
                              background: "rgba(255,59,92,0.08)",
                              border: "1px solid rgba(255,59,92,0.35)",
                              color: "#FF3B5C",
                              cursor: "pointer",
                              borderRadius: 2,
                              fontWeight: 600,
                            }}
                          >
                            Supprimer
                          </button>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--accent)", fontFamily: "var(--font-mono)", marginBottom: 12 }}>
                          {plan.calorieTarget} kcal · {plan.proteinTarget} g prot — {plan.adjustment}
                        </div>
                        {DAYS.map((day) => {
                          const dayPlan = plan.days[day];
                          if (!dayPlan) return null;
                          const open = expandedPlanDay === `${plan.weekStart}-${day}`;
                          return (
                            <button
                              key={day}
                              type="button"
                              onClick={() => setExpandedPlanDay(open ? null : `${plan.weekStart}-${day}`)}
                              style={{
                                width: "100%",
                                textAlign: "left",
                                background: open ? "rgba(77,170,255,0.06)" : "var(--bg-raised)",
                                borderRadius: 2,
                                padding: "10px 12px",
                                marginBottom: 6,
                                border: open ? "1px solid rgba(77,170,255,0.25)" : "1px solid var(--border)",
                                color: "inherit",
                                font: "inherit",
                                cursor: "pointer",
                              }}
                            >
                              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 13, textTransform: "uppercase" }}>
                                {day} · {dayPlan.total?.kcal ?? "?"} kcal
                              </div>
                              {open ? (
                                <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
                                  {Object.entries(MEAL_LABELS).map(([k, meta]) => {
                                    const m = dayPlan[k as keyof GeneratedPlanDay];
                                    if (!m || typeof m !== "object" || !("name" in m)) return null;
                                    return (
                                      <div key={k} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
                                        <span style={{ color: "var(--accent2)", fontFamily: "var(--font-mono)", fontSize: 9 }}>{meta.label}</span>
                                        <div style={{ fontWeight: 700 }}>{m.name}</div>
                                        <div style={{ color: "var(--dim)", fontSize: 11 }}>{m.detail}</div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <p style={{ fontSize: 12, color: "var(--dim)", fontFamily: "var(--font-mono)" }}>Aucun plan généré pour l’instant.</p>
              )}
            </div>
          )}

          {/* ============ NUTRITION TAB ============ */}
          {activeTab === "nutrition" && dayMeals && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "clamp(12px, 3vw, 18px)" }}>
                <div style={{ width: 3, height: 22, background: "var(--accent)", flexShrink: 0 }} />
                <h2
                  className="app-section-title"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 900,
                    margin: 0,
                    textTransform: "uppercase",
                    letterSpacing: "-0.01em",
                  }}
                >
                  Repas — {selectedDay}
                </h2>
              </div>

              {/* Macro summary */}
              <div
                className="app-card app-card-pad"
                style={{ background: "var(--bg-card)", borderRadius: 4, marginBottom: 16, border: "1px solid var(--border)" }}
              >
                <div style={{ display: "flex", gap: "clamp(16px, 4vw, 28px)", marginBottom: 16, flexWrap: "wrap" }}>
                  {[
                    { label: "KCAL", value: dayMeals.total.kcal, color: "var(--accent)" },
                    { label: "PROT", value: `${dayMeals.total.p}G`, color: "#FF3B5C" },
                    { label: "GLUC", value: `${dayMeals.total.l}G`, color: "#4DAAFF" },
                    { label: "LIP", value: `${dayMeals.total.g}G`, color: "#A07AF5" },
                  ].map((item) => (
                    <div key={item.label}>
                      <div
                        style={{
                          fontFamily: "var(--font-display)",
                          fontSize: "clamp(1.4rem, 5vw, 1.9rem)",
                          fontWeight: 900,
                          color: item.color,
                          lineHeight: 1,
                          letterSpacing: "-0.01em",
                        }}
                      >
                        {item.value}
                      </div>
                      <div
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 8,
                          color: "var(--dim)",
                          textTransform: "uppercase",
                          letterSpacing: "0.13em",
                          marginTop: 3,
                        }}
                      >
                        {item.label}
                      </div>
                    </div>
                  ))}
                </div>
                <MacroBar label="Calories" value={dayMeals.total.kcal} max={2800} color="var(--accent)" unit=" kcal" />
                <MacroBar label="Protéines" value={dayMeals.total.p} max={200} color="#FF3B5C" unit="g" />
                <MacroBar label="Glucides" value={dayMeals.total.l} max={350} color="#4DAAFF" unit="g" />
                <MacroBar label="Lipides" value={dayMeals.total.g} max={80} color="#A07AF5" unit="g" />
              </div>

              {/* Meal cards */}
              {Object.entries(MEAL_LABELS).map(([key, meta]) => {
                const meal = dayMeals[key as keyof typeof dayMeals];
                if (!meal || typeof meal !== "object" || !("name" in meal)) return null;
                const isOpen = expandedMeal === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setExpandedMeal(isOpen ? null : key)}
                    aria-expanded={isOpen}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      background: "var(--bg-card)",
                      borderRadius: 2,
                      padding: "14px 18px",
                      marginBottom: 8,
                      cursor: "pointer",
                      border: isOpen ? "1px solid rgba(190,255,0,0.22)" : "1px solid var(--border)",
                      transition: "border-color 0.15s",
                      color: "inherit",
                      font: "inherit",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 20 }} aria-hidden>{meta.icon}</span>
                        <div>
                          <div
                            style={{
                              fontFamily: "var(--font-display)",
                              fontSize: "clamp(13px, 3vw, 16px)",
                              fontWeight: 800,
                              textTransform: "uppercase",
                              letterSpacing: "0.01em",
                            }}
                          >
                            {meal.name}
                          </div>
                          <div
                            style={{
                              fontSize: 9,
                              color: "var(--dim)",
                              fontFamily: "var(--font-mono)",
                              marginTop: 2,
                              letterSpacing: "0.08em",
                              textTransform: "uppercase",
                            }}
                          >
                            {meta.time} · {meta.label}
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div
                          style={{
                            fontFamily: "var(--font-display)",
                            fontSize: "clamp(18px, 4.5vw, 24px)",
                            fontWeight: 900,
                            color: "var(--accent)",
                            lineHeight: 1,
                            letterSpacing: "-0.02em",
                          }}
                        >
                          {meal.kcal}
                        </div>
                        <div style={{ fontSize: 8, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                          KCAL
                        </div>
                      </div>
                    </div>
                    {isOpen && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                        <p style={{ fontSize: 13, color: "var(--text)", margin: "0 0 12px", lineHeight: 1.65, fontFamily: "var(--font-body)" }}>
                          {meal.detail}
                        </p>
                        <div style={{ display: "flex", gap: 6, fontSize: 9, fontFamily: "var(--font-mono)", fontWeight: 600, flexWrap: "wrap" }}>
                          <span style={{ background: "rgba(255,59,92,0.1)", color: "#FF3B5C", padding: "3px 8px", borderRadius: 1, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                            P {meal.p}G
                          </span>
                          <span style={{ background: "rgba(77,170,255,0.1)", color: "#4DAAFF", padding: "3px 8px", borderRadius: 1, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                            G {meal.l}G
                          </span>
                          <span style={{ background: "rgba(160,122,245,0.1)", color: "#A07AF5", padding: "3px 8px", borderRadius: 1, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                            L {meal.g}G
                          </span>
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* ============ TRAINING TAB ============ */}
          {activeTab === "training" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <div style={{ width: 3, height: 22, background: daySchedule.color, flexShrink: 0 }} />
                <h2
                  className="app-section-title"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 900,
                    margin: 0,
                    color: daySchedule.color,
                    textTransform: "uppercase",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {daySchedule.muscle}
                </h2>
              </div>
              <p
                className="app-typo-sub"
                style={{ color: "var(--dim)", margin: "0 0 clamp(14px, 3vw, 22px)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.07em" }}
              >
                {selectedDay === "Samedi" || selectedDay === "Dimanche"
                  ? "Repos complet — laisse les muscles récupérer"
                  : "6h00 — 7h15 · ~75 min"}
              </p>

              {WORKOUT_DETAILS[daySchedule.muscle as keyof typeof WORKOUT_DETAILS] ? (
                WORKOUT_DETAILS[daySchedule.muscle as keyof typeof WORKOUT_DETAILS].map((exo, i) => {
                  const isOpen = expandedExo === i;
                  const lastSession = [...workoutLog]
                    .filter((e) => e.exercise === exo.name)
                    .sort((a, b) => b.date.localeCompare(a.date))[0];
                  return (
                    <button
                      key={exo.name}
                      type="button"
                      onClick={() => openExo(isOpen ? null : i)}
                      aria-expanded={isOpen}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        background: isOpen ? "var(--bg-raised)" : "var(--bg-card)",
                        borderRadius: 2,
                        padding: "16px 20px",
                        marginBottom: 8,
                        cursor: "pointer",
                        border: "1px solid var(--border)",
                        borderLeft: `3px solid ${daySchedule.color}`,
                        transition: "background 0.15s",
                        color: "inherit",
                        font: "inherit",
                        position: "relative",
                        overflow: "hidden",
                      }}
                    >
                      {/* Watermark number */}
                      <span
                        style={{
                          position: "absolute",
                          right: 10,
                          top: -10,
                          fontFamily: "var(--font-display)",
                          fontSize: 90,
                          fontWeight: 900,
                          color: daySchedule.color,
                          opacity: 0.05,
                          lineHeight: 1,
                          userSelect: "none",
                          pointerEvents: "none",
                          letterSpacing: "-0.04em",
                        }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>

                      <div className="app-training-row-head">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              fontFamily: "var(--font-display)",
                              fontSize: "clamp(14px, 3.5vw, 18px)",
                              fontWeight: 800,
                              textTransform: "uppercase",
                              letterSpacing: "0.01em",
                              lineHeight: 1.1,
                            }}
                          >
                            {exo.name}
                          </div>
                          <div
                            style={{
                              fontSize: 10,
                              color: "var(--dim)",
                              fontFamily: "var(--font-mono)",
                              marginTop: 5,
                              letterSpacing: "0.06em",
                            }}
                          >
                            {exo.sets}
                          </div>
                        </div>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            startTimer(parseRestSeconds(exo.rest), exo.name);
                          }}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); startTimer(parseRestSeconds(exo.rest), exo.name); } }}
                          aria-label={`Lancer le timer de repos — ${exo.rest}`}
                          style={{
                            fontSize: 9,
                            fontFamily: "var(--font-mono)",
                            color: daySchedule.color,
                            fontWeight: 600,
                            flexShrink: 0,
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            cursor: "pointer",
                            background: `${daySchedule.color}15`,
                            border: `1px solid ${daySchedule.color}40`,
                            borderRadius: 2,
                            padding: "4px 8px",
                          }}
                        >
                          ⏱ {exo.rest}
                        </div>
                      </div>
                      {isOpen && (
                        <div
                          style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div style={{ fontSize: 13, color: "var(--accent2)", lineHeight: 1.6, fontFamily: "var(--font-body)", fontStyle: "italic", marginBottom: 14 }}>
                            {exo.note}
                          </div>

                          {/* Last session — editable */}
                          {lastSession && (
                            <div style={{ marginBottom: 12, background: "var(--bg)", borderRadius: 2, padding: "10px 12px", border: "1px solid var(--border)" }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                                <div style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                                  Dernière séance · {formatFrDate(lastSession.date)}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => deleteSession(lastSession.exercise, lastSession.date)}
                                  style={{ background: "transparent", border: "1px solid rgba(255,59,92,0.25)", borderRadius: 2, color: "var(--accent3)", fontFamily: "var(--font-mono)", fontSize: 8, cursor: "pointer", padding: "3px 7px", textTransform: "uppercase", letterSpacing: "0.08em" }}
                                >
                                  Supprimer séance
                                </button>
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                                {lastSession.sets.map((s, si) => {
                                  const isEditing = editingSet?.exercise === lastSession.exercise && editingSet?.date === lastSession.date && editingSet?.idx === si;
                                  return (
                                    <div key={si} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                      <span style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", minWidth: 18 }}>S{si + 1}</span>
                                      {isEditing ? (
                                        <>
                                          <input
                                            type="number"
                                            aria-label="Poids (kg)"
                                            value={editSetKg}
                                            onChange={(e) => setEditSetKg(e.target.value)}
                                            style={{ ...inputStyle, width: 60, padding: "4px 7px", fontSize: 11 }}
                                            autoFocus
                                          />
                                          <span style={{ color: "var(--dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>×</span>
                                          <input
                                            type="number"
                                            aria-label="Répétitions"
                                            value={editSetReps}
                                            onChange={(e) => setEditSetReps(e.target.value)}
                                            onKeyDown={(e) => { if (e.key === "Enter") saveEditSet(); if (e.key === "Escape") setEditingSet(null); }}
                                            style={{ ...inputStyle, width: 60, padding: "4px 7px", fontSize: 11 }}
                                          />
                                          <button type="button" onClick={saveEditSet} style={{ background: daySchedule.color, border: "none", borderRadius: 2, color: "#0A0A0E", fontFamily: "var(--font-mono)", fontSize: 9, cursor: "pointer", padding: "4px 8px", fontWeight: 700 }}>OK</button>
                                          <button type="button" aria-label="Annuler la modification" onClick={() => setEditingSet(null)} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 2, color: "var(--dim)", fontFamily: "var(--font-mono)", fontSize: 9, cursor: "pointer", padding: "4px 8px" }}>✕</button>
                                        </>
                                      ) : (
                                        <>
                                          <span style={{ background: `${daySchedule.color}18`, border: `1px solid ${daySchedule.color}35`, borderRadius: 2, padding: "3px 8px", fontSize: 10, fontFamily: "var(--font-mono)", color: daySchedule.color, flex: 1 }}>
                                            {s.kg} kg × {s.reps} reps
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => startEditSet(lastSession.exercise, lastSession.date, si, s.kg, s.reps)}
                                            style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 2, color: "var(--dim)", fontFamily: "var(--font-mono)", fontSize: 9, cursor: "pointer", padding: "3px 7px" }}
                                            aria-label={`Modifier la série ${si + 1}`}
                                          >
                                            ✏
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => deleteSetFromLog(lastSession.exercise, lastSession.date, si)}
                                            style={{ background: "transparent", border: "1px solid rgba(255,59,92,0.25)", borderRadius: 2, color: "var(--accent3)", fontFamily: "var(--font-mono)", fontSize: 9, cursor: "pointer", padding: "3px 7px" }}
                                            aria-label={`Supprimer la série ${si + 1}`}
                                          >
                                            ✕
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Pending sets — deletable */}
                          {pendingExoSets.length > 0 && (
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 9, color: "var(--accent)", fontFamily: "var(--font-mono)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                                Cette séance (non sauvegardée)
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                                {pendingExoSets.map((s, si) => (
                                  <div key={si} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", minWidth: 18 }}>S{si + 1}</span>
                                    <span style={{ background: "rgba(190,255,0,0.1)", border: "1px solid rgba(190,255,0,0.25)", borderRadius: 2, padding: "3px 8px", fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--accent)", flex: 1 }}>
                                      {s.kg} kg × {s.reps} reps
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => deletePendingSet(si)}
                                      style={{ background: "transparent", border: "1px solid rgba(255,59,92,0.25)", borderRadius: 2, color: "var(--accent3)", fontFamily: "var(--font-mono)", fontSize: 9, cursor: "pointer", padding: "3px 7px" }}
                                      aria-label={`Supprimer la série en attente ${si + 1}`}
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Add set form */}
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <input
                              type="number"
                              placeholder="kg"
                              aria-label="Poids de la série (kg)"
                              value={logKg}
                              onChange={(e) => setLogKg(e.target.value)}
                              style={{ ...inputStyle, width: 70, padding: "7px 10px", fontSize: 12 }}
                            />
                            <span style={{ color: "var(--dim)", fontSize: 12, fontFamily: "var(--font-mono)" }}>×</span>
                            <input
                              type="number"
                              placeholder="reps"
                              aria-label="Nombre de répétitions"
                              value={logReps}
                              onChange={(e) => setLogReps(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") addPendingSet(); }}
                              style={{ ...inputStyle, width: 70, padding: "7px 10px", fontSize: 12 }}
                            />
                            <button
                              type="button"
                              onClick={addPendingSet}
                              style={{ padding: "7px 12px", background: daySchedule.color, border: "none", borderRadius: 2, color: "#0A0A0E", fontFamily: "var(--font-mono)", fontSize: 10, cursor: "pointer", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}
                            >
                              + Série
                            </button>
                            {pendingExoSets.length > 0 && (
                              <button
                                type="button"
                                onClick={() => savePendingSession(exo.name)}
                                style={{ padding: "7px 12px", background: "transparent", border: `1px solid ${daySchedule.color}`, borderRadius: 2, color: daySchedule.color, fontFamily: "var(--font-mono)", fontSize: 10, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.06em" }}
                              >
                                Sauvegarder
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </button>
                  );
                })
              ) : (
                <div
                  style={{
                    background: "var(--bg-card)",
                    borderRadius: 4,
                    padding: 40,
                    textAlign: "center",
                    border: "1px solid var(--border)",
                  }}
                >
                  <span style={{ fontSize: 44 }}>🛌</span>
                  <p
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: 20,
                      fontWeight: 800,
                      textTransform: "uppercase",
                      letterSpacing: "0.02em",
                      marginTop: 12,
                    }}
                  >
                    Repos complet
                  </p>
                  <p style={{ fontSize: 13, color: "var(--dim)", marginTop: 6, lineHeight: 1.6 }}>
                    Les muscles grandissent pendant le repos. Mange bien, dors bien, hydrate-toi.
                  </p>
                </div>
              )}

              {WORKOUT_DETAILS[daySchedule.muscle as keyof typeof WORKOUT_DETAILS] && (
                <div
                  style={{
                    background: "rgba(190,255,0,0.05)",
                    borderRadius: 2,
                    padding: "12px 16px",
                    marginTop: 12,
                    fontSize: 12,
                    color: "var(--accent)",
                    border: "1px solid rgba(190,255,0,0.1)",
                    lineHeight: 1.6,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  Augmente les charges progressivement (surcharge progressive). Dors et hydrate — suivi poids dans l'onglet Suivi.
                </div>
              )}
            </div>
          )}

          {/* ============ MEAL PREP TAB ============ */}
          {activeTab === "mealprep" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "clamp(14px, 3vw, 22px)" }}>
                <div style={{ width: 3, height: 22, background: "var(--accent)", flexShrink: 0 }} />
                <h2
                  className="app-section-title"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 900,
                    margin: 0,
                    textTransform: "uppercase",
                    letterSpacing: "-0.01em",
                  }}
                >
                  Meal Prep & Courses
                </h2>
              </div>

              <div
                className="app-card-pad"
                style={{
                  background: "var(--bg-card)",
                  borderRadius: 4,
                  marginBottom: 16,
                  border: "1px solid var(--border)",
                  borderLeft: "2px solid #4DAAFF",
                }}
              >
                <h3
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: 14,
                    fontWeight: 800,
                    margin: "0 0 8px",
                    color: "#4DAAFF",
                    textTransform: "uppercase",
                  }}
                >
                  Estimation budget courses
                </h3>
                <p style={{ fontSize: 11, color: "var(--dim)", margin: "0 0 10px", lineHeight: 1.55, fontFamily: "var(--font-mono)" }}>
                  Aucune API publique ne donne les prix réels des magasins en France. Ici: grille indicative (€) pour les quantités de la liste ci-dessous, type grande surface.
                </p>
                <div style={{ fontFamily: "var(--font-display)", fontSize: "clamp(1.5rem, 5vw, 2rem)", fontWeight: 900, color: "var(--accent)" }}>
                  ~{groceryEstimate.total.toFixed(0)} €
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--dim)", marginLeft: 8, fontFamily: "var(--font-mono)" }}>pour la liste type</span>
                </div>
              </div>

              <div
                className="app-card-pad"
                style={{
                  background: "var(--bg-card)",
                  borderRadius: 4,
                  marginBottom: 18,
                  border: "1px solid var(--border)",
                }}
              >
                <h3
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: 14,
                    fontWeight: 800,
                    margin: "0 0 8px",
                    textTransform: "uppercase",
                  }}
                >
                  Prep semaine (IA)
                </h3>
                <p style={{ fontSize: 11, color: "var(--dim)", margin: "0 0 10px", lineHeight: 1.5 }}>
                  Génère des sessions de batch (comme le plan statique) à partir de ton profil ({latestWeight?.kg ?? "—"} kg, {userProfile.heightCm} cm,{" "}
                  {userProfile.goal === "cut" ? "sèche" : "prise de masse"}) et du plan hebdo IA correspondant si disponible. Clé API dans l’onglet Hebdo (Gemini).
                </p>
                <p style={{ fontSize: 10, color: "var(--dim)", margin: "0 0 10px", lineHeight: 1.45, fontFamily: "var(--font-mono)" }}>
                  Chaque nouvelle génération est enregistrée ; tu peux rouvrir une semaine précédente dans le menu ci-dessous.
                </p>
                <button
                  type="button"
                  disabled={!apiKey || prepGenerating}
                  onClick={() => generatePrepWeeklyPlan()}
                  style={{
                    padding: "11px 16px",
                    borderRadius: 2,
                    border: "none",
                    background: apiKey && !prepGenerating ? "var(--accent)" : "var(--border)",
                    color: apiKey && !prepGenerating ? "#0A0A0E" : "var(--dim)",
                    fontWeight: 800,
                    fontFamily: "var(--font-display)",
                    fontSize: 12,
                    cursor: apiKey && !prepGenerating ? "pointer" : "not-allowed",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    width: "100%",
                  }}
                >
                  {prepGenerating ? "Génération du prep…" : "Générer le prep de la semaine"}
                </button>
                {prepError ? <p style={{ color: "#FF3B5C", fontSize: 12, marginTop: 10, fontFamily: "var(--font-mono)" }}>{prepError}</p> : null}
                {prepPlans.length > 0 ? (
                  <div style={{ marginTop: 14 }}>
                    {prepPlans.length > 1 ? (
                      <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                        <span style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                          Voir un prep (historique)
                        </span>
                        <select
                          value={Math.min(selectedPrepIndex, prepPlans.length - 1)}
                          onChange={(e) => setSelectedPrepIndex(Number(e.target.value))}
                          style={{
                            background: "var(--bg-raised)",
                            border: "1px solid var(--border)",
                            color: "var(--text)",
                            padding: "10px 12px",
                            fontFamily: "var(--font-body)",
                            fontSize: 13,
                            borderRadius: 2,
                            maxWidth: "100%",
                          }}
                        >
                          {prepPlans.map((p, i) => (
                            <option key={p.weekStart + p.generatedAt} value={i}>
                              Semaine du {formatFrDate(p.weekStart)} — {formatFrDate(p.generatedAt.slice(0, 10))}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {(() => {
                      const pIdx = Math.min(selectedPrepIndex, prepPlans.length - 1);
                      const prepPlan = prepPlans[pIdx];
                      if (!prepPlan) return null;
                      return (
                        <>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              alignItems: "flex-start",
                              justifyContent: "space-between",
                              gap: 10,
                              marginBottom: 8,
                            }}
                          >
                            <div style={{ fontSize: 10, color: "var(--dim)", fontFamily: "var(--font-mono)", flex: "1 1 200px" }}>
                              Semaine du {formatFrDate(prepPlan.weekStart)} · {prepPlan.calorieTarget} kcal/j · objectif {prepPlan.goalLabel}
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                if (window.confirm("Supprimer ce prep de l’historique ?")) removePrepPlanAt(pIdx);
                              }}
                              style={{
                                flexShrink: 0,
                                padding: "6px 12px",
                                fontSize: 10,
                                fontFamily: "var(--font-mono)",
                                textTransform: "uppercase",
                                letterSpacing: "0.06em",
                                background: "rgba(255,59,92,0.08)",
                                border: "1px solid rgba(255,59,92,0.35)",
                                color: "#FF3B5C",
                                cursor: "pointer",
                                borderRadius: 2,
                                fontWeight: 600,
                              }}
                            >
                              Supprimer
                            </button>
                          </div>
                          {prepPlan.notes ? (
                            <p style={{ fontSize: 12, color: "var(--accent)", margin: "0 0 12px", fontStyle: "italic" }}>{prepPlan.notes}</p>
                          ) : null}
                          {prepPlan.sessions.map((sess, si) => (
                            <div
                              key={`prep-sess-${si}-${sess.key}`}
                              style={{
                                background: "rgba(190,255,0,0.04)",
                                borderRadius: 2,
                                padding: "12px 14px",
                                marginBottom: 10,
                                border: "1px solid rgba(190,255,0,0.12)",
                              }}
                            >
                              <h4 style={{ fontFamily: "var(--font-display)", fontSize: 13, fontWeight: 800, margin: "0 0 10px", color: "var(--accent)" }}>
                                {sess.label}
                              </h4>
                              {sess.tasks.map((task, i) => (
                                <div key={i} style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 6 }}>
                                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--accent2)", minWidth: 22 }}>{String(i + 1).padStart(2, "0")}</span>
                                  <span style={{ fontSize: 12, lineHeight: 1.55 }}>{task}</span>
                                </div>
                              ))}
                            </div>
                          ))}
                        </>
                      );
                    })()}
                  </div>
                ) : null}
              </div>

              <div style={{ marginBottom: 10, fontSize: 12, color: "var(--dim)", fontFamily: "var(--font-mono)" }}>Plan de référence (statique)</div>

              {Object.entries(COOKING_PLAN).map(([key, plan]) => (
                <div
                  key={key}
                  className="app-card-pad"
                  style={{
                    background: "var(--bg-card)",
                    borderRadius: 2,
                    marginBottom: 10,
                    border: "1px solid var(--border)",
                    borderLeft: "2px solid var(--accent)",
                  }}
                >
                  <h3
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: "clamp(14px, 3.5vw, 17px)",
                      fontWeight: 800,
                      margin: "0 0 12px",
                      color: "var(--accent)",
                      textTransform: "uppercase",
                      letterSpacing: "0.01em",
                    }}
                  >
                    {plan.label}
                  </h3>
                  {plan.tasks.map((task, i) => (
                    <div key={i} style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 8 }}>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 9,
                          color: "var(--accent2)",
                          fontWeight: 600,
                          minWidth: 22,
                          paddingTop: 3,
                          letterSpacing: "0.05em",
                        }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span style={{ fontSize: 13, lineHeight: 1.6, fontFamily: "var(--font-body)", color: "var(--text)" }}>
                        {task}
                      </span>
                    </div>
                  ))}
                </div>
              ))}

              {/* Grocery list */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  margin: "24px 0 10px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 3, height: 20, background: "var(--accent2)", flexShrink: 0 }} />
                  <h3
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: "clamp(16px, 4vw, 20px)",
                      fontWeight: 800,
                      margin: 0,
                      textTransform: "uppercase",
                      letterSpacing: "0.01em",
                    }}
                  >
                    Liste de courses
                  </h3>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--dim)", letterSpacing: "0.06em" }}>
                    {groceryChecked}/{GROCERIES.length}
                  </span>
                  <button
                    type="button"
                    onClick={resetGroceries}
                    style={{
                      padding: "5px 10px",
                      borderRadius: 2,
                      border: "1px solid var(--border)",
                      background: "transparent",
                      color: "var(--dim)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      cursor: "pointer",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                    }}
                  >
                    Réinitialiser
                  </button>
                </div>
              </div>
              <p style={{ fontSize: 11, color: "var(--dim)", margin: "0 0 12px", lineHeight: 1.5, fontFamily: "var(--font-mono)", letterSpacing: "0.04em" }}>
                Coche ce que tu as déjà — sauvegardé sur cet appareil.
              </p>
              <div className="app-grocery-grid">
                {GROCERIES.map((g) => {
                  const checked = Boolean(groceryDone[g.item]);
                  return (
                    <label
                      key={g.item}
                      style={{
                        background: checked ? "rgba(77,170,255,0.05)" : "var(--bg-card)",
                        borderRadius: 2,
                        padding: "11px 13px",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                        cursor: "pointer",
                        border: checked ? "1px solid rgba(77,170,255,0.2)" : "1px solid var(--border)",
                        transition: "border-color 0.15s, background 0.15s",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleGrocery(g.item)}
                        style={{ width: 15, height: 15, marginTop: 3, accentColor: "#4DAAFF", cursor: "pointer", flexShrink: 0 }}
                      />
                      <span style={{ fontSize: 18, lineHeight: 1 }} aria-hidden>{g.icon}</span>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            textDecoration: checked ? "line-through" : "none",
                            color: checked ? "var(--dim)" : "var(--text)",
                            fontFamily: "var(--font-body)",
                          }}
                        >
                          {g.item}
                        </div>
                        <div style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", marginTop: 2, letterSpacing: "0.05em" }}>
                          {g.qty}
                        </div>
                        <div style={{ fontSize: 8, color: "#4DAAFF", fontFamily: "var(--font-mono)", marginTop: 3, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                          {g.cat}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* ============ SUIVI TAB ============ */}
          {activeTab === "suivi" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "clamp(14px, 3vw, 22px)" }}>
                <div style={{ width: 3, height: 22, background: "var(--accent)", flexShrink: 0 }} />
                <h2
                  className="app-section-title"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 900,
                    margin: 0,
                    textTransform: "uppercase",
                    letterSpacing: "-0.01em",
                  }}
                >
                  Suivi du poids
                </h2>
              </div>

              {/* Form */}
              <form
                onSubmit={submitWeight}
                className="app-suivi-form app-card-pad"
                style={{
                  background: "var(--bg-card)",
                  borderRadius: 4,
                  marginBottom: 20,
                  border: "1px solid var(--border)",
                }}
              >
                <div className="app-suivi-field-date" style={{ flex: "1 1 140px" }}>
                  <label
                    htmlFor="w-date"
                    style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em" }}
                  >
                    Date
                  </label>
                  <input
                    id="w-date"
                    type="date"
                    value={newDate}
                    onChange={(e) => { setNewDate(e.target.value); setWeightFormError(null); }}
                    style={inputStyle}
                  />
                </div>
                <div className="app-suivi-field-kg" style={{ flex: "1 1 100px" }}>
                  <label
                    htmlFor="w-kg"
                    style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em" }}
                  >
                    Poids (kg)
                  </label>
                  <input
                    id="w-kg"
                    type="number"
                    step="0.1"
                    min={35}
                    max={220}
                    value={newKg}
                    onChange={(e) => { setNewKg(e.target.value); setWeightFormError(null); }}
                    placeholder="ex. 62.5"
                    style={inputStyle}
                  />
                </div>
                <button
                  type="submit"
                  className="app-suivi-submit"
                  style={{
                    padding: "10px 24px",
                    borderRadius: 2,
                    border: "none",
                    background: "var(--accent)",
                    color: "#0A0A0E",
                    fontFamily: "var(--font-display)",
                    fontSize: 14,
                    fontWeight: 800,
                    cursor: "pointer",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  Ajouter
                </button>
                {weightFormError ? (
                  <div
                    role="alert"
                    style={{
                      flex: "1 1 100%",
                      fontSize: 11,
                      color: "var(--accent3)",
                      fontFamily: "var(--font-mono)",
                      margin: 0,
                      letterSpacing: "0.04em",
                    }}
                  >
                    {weightFormError}
                  </div>
                ) : null}
              </form>

              {/* Weight chart */}
              {weights.length > 0 &&
                (() => {
                  const minW = Math.min(...weights.map((w) => w.kg)) - 1;
                  const maxW = Math.max(...weights.map((w) => w.kg)) + 1;
                  const range = maxW - minW || 1;
                  const svgW = 700;
                  const svgH = 220;
                  const padX = 52;
                  const padY = 16;
                  const plotW = svgW - padX * 2;
                  const plotH = svgH - padY * 2;
                  const pts = weights.map((w, i) => ({
                    x: padX + (weights.length === 1 ? plotW / 2 : (i / (weights.length - 1)) * plotW),
                    y: padY + plotH - ((w.kg - minW) / range) * plotH,
                    ...w,
                  }));
                  const linePath = smoothBezierPath(pts);
                  const areaPath = `${linePath} L ${pts[pts.length - 1].x} ${padY + plotH} L ${pts[0].x} ${padY + plotH} Z`;
                  return (
                    <div
                      style={{
                        background: "var(--bg-card)",
                        borderRadius: 4,
                        padding: "16px 16px 12px",
                        marginBottom: 16,
                        border: "1px solid var(--border)",
                        overflow: "hidden",
                      }}
                    >
                      <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{ width: "100%", height: "auto" }} aria-label="Courbe de poids">
                        <defs>
                          <linearGradient id="wFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#BEFF00" stopOpacity="0.18" />
                            <stop offset="100%" stopColor="#BEFF00" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                          const y = padY + plotH - f * plotH;
                          const val = (minW + f * range).toFixed(1);
                          return (
                            <g key={f}>
                              <line x1={padX} y1={y} x2={svgW - padX} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
                              <text x={padX - 8} y={y + 4} textAnchor="end" fill="#484862" fontSize="10" fontFamily="IBM Plex Mono, monospace">
                                {val}
                              </text>
                            </g>
                          );
                        })}
                        <path d={areaPath} fill="url(#wFill)" />
                        <path d={linePath} fill="none" stroke="#BEFF00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        {pts.map((p, i) => (
                          <circle key={i} cx={p.x} cy={p.y} r="4" fill="#BEFF00" stroke="#0A0A0E" strokeWidth="2" />
                        ))}
                      </svg>
                      <div
                        style={{
                          textAlign: "center",
                          fontFamily: "var(--font-mono)",
                          fontSize: 9,
                          color: "var(--dim)",
                          marginTop: 6,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        {weights.length === 1
                          ? `Pesée : ${weights[0].kg} kg`
                          : `${weights[0].date} → ${weights[weights.length - 1].date}`}
                      </div>
                    </div>
                  );
                })()}

              {/* Weight log */}
              <div style={{ background: "var(--bg-card)", borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
                {weights.length === 0 ? (
                  <div style={{ padding: 40, textAlign: "center" }}>
                    <span style={{ fontSize: 32 }}>⚖️</span>
                    <p
                      style={{
                        fontFamily: "var(--font-display)",
                        fontSize: 16,
                        fontWeight: 800,
                        textTransform: "uppercase",
                        letterSpacing: "0.02em",
                        marginTop: 12,
                        color: "var(--dim)",
                      }}
                    >
                      Aucune pesée
                    </p>
                    <p style={{ fontSize: 12, color: "var(--dim)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
                      Ajoute ta première pesée pour commencer le suivi.
                    </p>
                  </div>
                ) : (
                  weights
                    .slice()
                    .reverse()
                    .map((w) => (
                      <div
                        key={w.date}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "12px 16px",
                          borderBottom: "1px solid var(--border)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                          <span
                            style={{
                              fontFamily: "var(--font-display)",
                              fontSize: "clamp(16px, 4vw, 20px)",
                              fontWeight: 900,
                              color: "var(--accent)",
                              letterSpacing: "-0.01em",
                              textTransform: "uppercase",
                            }}
                          >
                            {w.kg} KG
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 9,
                              color: "var(--dim)",
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                            }}
                          >
                            {formatFrDate(w.date)}
                          </span>
                        </div>
                        <button
                          type="button"
                          aria-label={`Supprimer la pesée du ${formatFrDate(w.date)}`}
                          onClick={() => removeWeight(w.date)}
                          style={{
                            background: "rgba(255,59,92,0.06)",
                            border: "1px solid rgba(255,59,92,0.15)",
                            borderRadius: 2,
                            color: "var(--accent3)",
                            cursor: "pointer",
                            fontSize: 9,
                            fontFamily: "var(--font-mono)",
                            padding: "5px 10px",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                          }}
                        >
                          Supprimer
                        </button>
                      </div>
                    ))
                )}
              </div>

              {weights.length >= 2 && (
                <div
                  style={{
                    background: "rgba(77,170,255,0.06)",
                    borderRadius: 2,
                    padding: "12px 16px",
                    marginTop: 12,
                    border: "1px solid rgba(77,170,255,0.12)",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--dim)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                    Évolution
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: "clamp(16px, 4vw, 20px)",
                      fontWeight: 900,
                      color: "#4DAAFF",
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {weights[weights.length - 1].kg - weights[0].kg >= 0 ? "+" : ""}
                    {(weights[weights.length - 1].kg - weights[0].kg).toFixed(1)} KG
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--dim)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    depuis le début
                  </span>
                </div>
              )}
            </div>
          )}
          {/* ============ ALIMENTS TAB ============ */}
          {activeTab === "aliments" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "clamp(14px, 3vw, 22px)" }}>
                <div style={{ width: 3, height: 22, background: "var(--accent)", flexShrink: 0 }} />
                <h2 className="app-section-title" style={{ fontFamily: "var(--font-display)", fontWeight: 900, margin: 0, textTransform: "uppercase", letterSpacing: "-0.01em" }}>
                  Infos nutritionnelles
                </h2>
              </div>

              {/* Search bar */}
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input
                  type="text"
                  aria-label="Rechercher un aliment"
                  value={foodQuery}
                  onChange={(e) => setFoodQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") searchFood(); }}
                  placeholder="ex. flocons d'avoine, poulet, skyr..."
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => searchFood()}
                  disabled={foodLoading}
                  style={{ padding: "10px 20px", background: "var(--accent)", border: "none", borderRadius: 2, color: "#0A0A0E", fontFamily: "var(--font-display)", fontSize: 13, fontWeight: 800, cursor: foodLoading ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0, opacity: foodLoading ? 0.6 : 1 }}
                >
                  {foodLoading ? "..." : "Chercher"}
                </button>
              </div>

              {/* Recent searches */}
              {recentSearches.length > 0 && !foodLoading && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
                  {recentSearches.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => searchFood(s)}
                      style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 2, color: "var(--dim)", fontFamily: "var(--font-mono)", fontSize: 9, cursor: "pointer", padding: "4px 10px", textTransform: "uppercase", letterSpacing: "0.07em" }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}

              {/* Favorites */}
              {foodFavorites.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <div style={{ width: 3, height: 16, background: "#FFD426", flexShrink: 0 }} />
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "#FFD426", textTransform: "uppercase", letterSpacing: "0.1em" }}>Mes favoris</span>
                  </div>
                  {foodFavorites.map((food, i) => {
                    const n = food.nutriments;
                    const g = 100;
                    return (
                      <div key={i} style={{ background: "var(--bg-card)", borderRadius: 2, padding: "10px 14px", marginBottom: 6, border: "1px solid var(--border)", borderLeft: "3px solid #FFD426", display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: "var(--font-display)", fontSize: "clamp(12px, 2.5vw, 14px)", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.01em" }}>{food.product_name}</div>
                          {food.brands && <div style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", marginTop: 2 }}>{food.brands}</div>}
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          {[
                            { v: Math.round(n["energy-kcal_100g"] * g / 100), u: "kcal", c: "#FF3B5C" },
                            { v: `${((n.proteins_100g ?? 0) * g / 100).toFixed(1)}g`, u: "P", c: "#A07AF5" },
                            { v: `${((n.carbohydrates_100g ?? 0) * g / 100).toFixed(1)}g`, u: "G", c: "#FFD426" },
                            { v: `${((n.fat_100g ?? 0) * g / 100).toFixed(1)}g`, u: "L", c: "#FF7033" },
                          ].map((m) => (
                            <span key={m.u} style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: m.c, fontWeight: 700 }}>{m.v} <span style={{ color: "var(--dim)", fontWeight: 400 }}>{m.u}</span></span>
                          ))}
                        </div>
                        <button type="button" onClick={() => toggleFoodFavorite(food)} aria-label="Retirer des favoris" style={{ background: "transparent", border: "none", color: "#FFD426", fontSize: 16, cursor: "pointer", flexShrink: 0, padding: 2 }}>★</button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Loading / results region — aria-live pour screen readers */}
              <div aria-live="polite" aria-atomic="false">
              {foodLoading && (
                <div role="status" style={{ textAlign: "center", padding: 48, color: "var(--dim)", fontFamily: "var(--font-mono)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  Chargement...
                </div>
              )}

              {/* No results */}
              {!foodLoading && foodSearched && foodResults.length === 0 && (
                <div style={{ textAlign: "center", padding: 48, color: "var(--dim)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.8 }}>
                  Aucun résultat pour "{foodQuery}".<br />Essaie un autre terme — ex: "avoine", "blanc de poulet", "skyr"
                </div>
              )}

              {/* Results */}
              {!foodLoading && foodResults.map((food, i) => {
                const n = food.nutriments;
                const isOpen = expandedFood === i;
                const g = parseFloat(portionGrams) || 100;
                const score = food.nutriscore_grade?.toLowerCase();
                const scoreColor = score ? (NUTRISCORE_COLOR[score] ?? "var(--dim)") : null;
                const macros = [
                  { label: "Kcal", value: Math.round(n["energy-kcal_100g"] * g / 100), raw: n["energy-kcal_100g"], color: "#FF3B5C" },
                  { label: "Protéines", value: `${((n.proteins_100g ?? 0) * g / 100).toFixed(1)}g`, raw: n.proteins_100g, color: "#A07AF5" },
                  { label: "Glucides", value: `${((n.carbohydrates_100g ?? 0) * g / 100).toFixed(1)}g`, raw: n.carbohydrates_100g, color: "#FFD426" },
                  { label: "Lipides", value: `${((n.fat_100g ?? 0) * g / 100).toFixed(1)}g`, raw: n.fat_100g, color: "#FF7033" },
                ];
                const extras = [
                  n.sugars_100g != null && { label: "Sucres", value: `${(n.sugars_100g * g / 100).toFixed(1)}g`, color: "#FF7033" },
                  n.fiber_100g != null && { label: "Fibres", value: `${(n.fiber_100g * g / 100).toFixed(1)}g`, color: "#4DAAFF" },
                  n.salt_100g != null && { label: "Sel", value: `${(n.salt_100g * g / 100).toFixed(2)}g`, color: "#84848C" },
                ].filter(Boolean) as { label: string; value: string; color: string }[];
                const fav = isFoodFavorite(food);

                return (
                  <div key={i} style={{ background: "var(--bg-card)", borderRadius: 2, marginBottom: 8, border: "1px solid var(--border)", borderLeft: `3px solid var(--accent)`, overflow: "hidden" }}>
                    {/* Header row — clickable */}
                    <button
                      type="button"
                      onClick={() => { setExpandedFood(isOpen ? null : i); setPortionGrams("100"); }}
                      style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "14px 16px", cursor: "pointer", color: "inherit", font: "inherit", display: "flex", alignItems: "flex-start", gap: 12 }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: "var(--font-display)", fontSize: "clamp(13px, 3vw, 16px)", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.01em" }}>
                          {food.product_name}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                          {food.brands && (
                            <span style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{food.brands}</span>
                          )}
                          {scoreColor && score && (
                            <span style={{ background: scoreColor, color: "#fff", fontFamily: "var(--font-display)", fontSize: 9, fontWeight: 900, padding: "2px 6px", borderRadius: 2, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                              Nutri-Score {score.toUpperCase()}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--accent)", letterSpacing: "0.08em" }}>{Math.round(n["energy-kcal_100g"])} kcal/100g</span>
                        <span style={{ color: "var(--dim)", fontSize: 11 }}>{isOpen ? "▲" : "▼"}</span>
                      </div>
                    </button>

                    {/* Expanded section */}
                    {isOpen && (
                      <div style={{ padding: "0 16px 16px", borderTop: "1px solid var(--border)" }}>

                        {/* Portion calculator */}
                        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 14px", flexWrap: "wrap" }}>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--dim)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Quantité</span>
                          <input
                            type="number"
                            aria-label="Quantité en grammes"
                            value={portionGrams}
                            onChange={(e) => setPortionGrams(e.target.value)}
                            min={1}
                            style={{ ...inputStyle, width: 80, padding: "6px 10px", fontSize: 13, fontWeight: 700 }}
                          />
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--dim)" }}>g</span>
                          {[50, 100, 150, 200].map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => setPortionGrams(String(preset))}
                              style={{ background: portionGrams === String(preset) ? "var(--accent)" : "var(--bg)", border: "1px solid var(--border)", borderRadius: 2, color: portionGrams === String(preset) ? "#0A0A0E" : "var(--dim)", fontFamily: "var(--font-mono)", fontSize: 9, cursor: "pointer", padding: "5px 10px", fontWeight: portionGrams === String(preset) ? 700 : 400 }}
                            >
                              {preset}g
                            </button>
                          ))}
                        </div>

                        {/* Macros */}
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: extras.length > 0 ? 10 : 0 }}>
                          {macros.map((m) => (
                            <div key={m.label} style={{ background: `${m.color}12`, border: `1px solid ${m.color}30`, borderRadius: 2, padding: "8px 12px", textAlign: "center", flex: "1 1 70px" }}>
                              <div style={{ fontSize: 16, fontWeight: 700, color: m.color, fontFamily: "var(--font-mono)" }}>{m.value}</div>
                              <div style={{ fontSize: 8, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 3 }}>{m.label}</div>
                            </div>
                          ))}
                        </div>

                        {/* Extras */}
                        {extras.length > 0 && (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
                            {extras.map((m) => (
                              <span key={m.label} style={{ background: `${m.color}10`, border: `1px solid ${m.color}25`, borderRadius: 2, padding: "4px 9px", fontSize: 10, fontFamily: "var(--font-mono)", color: m.color }}>
                                {m.label} {m.value}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Favorite button */}
                        <button
                          type="button"
                          onClick={() => toggleFoodFavorite(food)}
                          style={{ background: fav ? "rgba(255,212,38,0.1)" : "transparent", border: `1px solid ${fav ? "rgba(255,212,38,0.4)" : "var(--border)"}`, borderRadius: 2, color: fav ? "#FFD426" : "var(--dim)", fontFamily: "var(--font-mono)", fontSize: 10, cursor: "pointer", padding: "7px 14px", textTransform: "uppercase", letterSpacing: "0.07em" }}
                        >
                          {fav ? "★ Favori" : "☆ Ajouter aux favoris"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              </div>{/* end aria-live */}
            </div>
          )}

        </main>
      </div>

      {/* ============ FLOATING TIMER ============ */}
      {timerLeft > 0 && (
        <div
          role="status"
          aria-live="polite"
          aria-label={`Timer de repos — ${formatTimer(timerLeft)} restant`}
          style={{
            position: "fixed",
            bottom: "max(20px, env(safe-area-inset-bottom, 20px))",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#10101A",
            border: "1px solid rgba(190,255,0,0.25)",
            borderRadius: 4,
            padding: "12px 20px",
            display: "flex",
            alignItems: "center",
            gap: 16,
            zIndex: 100,
            boxShadow: "0 4px 32px rgba(0,0,0,0.6)",
            minWidth: 260,
          }}
        >
          {/* Progress ring */}
          <svg width={44} height={44} style={{ flexShrink: 0 }}>
            <circle cx={22} cy={22} r={18} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={3} />
            <circle
              cx={22} cy={22} r={18}
              fill="none"
              stroke="#BEFF00"
              strokeWidth={3}
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 18}
              strokeDashoffset={2 * Math.PI * 18 * (timerLeft / timerTotal)}
              transform="rotate(-90 22 22)"
              style={{ transition: "stroke-dashoffset 0.9s linear" }}
            />
            <text x={22} y={26} textAnchor="middle" fill="#BEFF00" fontSize={11} fontWeight={700} fontFamily="IBM Plex Mono, monospace">
              {formatTimer(timerLeft)}
            </text>
          </svg>

          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 9, color: "var(--dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>
              Repos — {timerLabel}
            </div>
            <div style={{ fontSize: 18, fontWeight: 900, fontFamily: "var(--font-display)", color: "var(--accent)", letterSpacing: "-0.01em", textTransform: "uppercase" }}>
              {formatTimer(timerLeft)}
            </div>
          </div>

          <button
            type="button"
            onClick={stopTimer}
            style={{ background: "transparent", border: "1px solid rgba(255,59,92,0.3)", borderRadius: 2, color: "var(--accent3)", fontFamily: "var(--font-mono)", fontSize: 9, cursor: "pointer", padding: "5px 10px", textTransform: "uppercase", letterSpacing: "0.08em", flexShrink: 0 }}
          >
            Annuler
          </button>
        </div>
      )}

    </div>
  );
}
