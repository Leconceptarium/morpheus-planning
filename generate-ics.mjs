#!/usr/bin/env node
/**
 * generate-ics.mjs
 * ---------------------------------------------------------------
 * Lit planning-data.json (le fichier publié par le bouton "Publier
 * en ligne" de l'appli Morpheus Planning) et génère un fichier .ics
 * par salarié dans le dossier ics/.
 *
 * Chaque salarié peut ensuite S'ABONNER (pas juste importer) à son
 * fichier depuis Apple Calendar ou Google Calendar : le calendrier
 * se remet à jour tout seul à chaque publication, sans rien
 * retélécharger.
 *
 * Aucune dépendance externe — Node.js seul suffit.
 * Usage : node generate-ics.mjs planning-data.json ics
 * ---------------------------------------------------------------
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const SRC = process.argv[2] || 'planning-data.json';
const OUT_DIR = process.argv[3] || 'ics';

const raw = readFileSync(SRC, 'utf8');
const bundle = JSON.parse(raw);
const config = bundle.config || {};
const planning = bundle.planning || {};
const absences = bundle.absences || {};
const employees = config.employees || [];
const roles = config.roles || [];
const codes = config.codes || [];

mkdirSync(OUT_DIR, { recursive: true });

// Nettoie les anciens .ics avant de régénérer (évite de garder un fichier
// pour un salarié supprimé de l'équipe).
try {
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.ics')) unlinkSync(join(OUT_DIR, f));
  }
} catch (e) { /* dossier vide ou inexistant, rien à faire */ }

function roleLabel(name) {
  const r = roles.find((x) => x.name === name);
  return r ? r.name : (name || 'Travail');
}
function codeLabel(code) {
  const c = codes.find((x) => x.code === code);
  return c ? `${c.code} — ${c.label}` : code;
}

// Formatte une date ISO (YYYY-MM-DD) + heure HH:MM en "floating time"
// ICS (sans Z, sans TZID) : interprétée dans le fuseau horaire de
// l'appareil de la personne abonnée. Comme toute l'équipe est en
// France, c'est le plus simple et le plus fiable.
function icsDateTime(iso, hhmm) {
  const [y, m, d] = iso.split('-');
  const [h, min] = hhmm.split(':');
  return `${y}${m}${d}T${h.padStart(2, '0')}${min.padStart(2, '0')}00`;
}
function icsDate(iso) {
  return iso.replaceAll('-', '');
}
function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
// Repli des lignes à 75 octets, requis par la norme ICS.
function foldLine(line) {
  if (line.length <= 75) return line;
  let out = '';
  let rest = line;
  while (rest.length > 75) {
    out += rest.slice(0, 75) + '\r\n ';
    rest = rest.slice(75);
  }
  return out + rest;
}

const nowStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

for (const emp of employees) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Morpheus Experience//Planning//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText('Morpheus — Planning de ' + emp.name)}`,
    'X-WR-TIMEZONE:Europe/Paris',
    // Indique aux clients qui le supportent (Google, Outlook) de
    // repasser régulièrement vérifier les mises à jour.
    'X-PUBLISHED-TTL:PT4H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT4H',
  ];

  // --- Créneaux de travail ---
  for (const [key, entry] of Object.entries(planning)) {
    const sep = key.indexOf('|');
    const empId = key.slice(0, sep);
    const iso = key.slice(sep + 1);
    if (empId !== emp.id) continue;
    if (absences[key]) continue; // une absence prime sur un créneau resté en mémoire

    const segments = [
      ['s1s', 's1e', '1'],
      ['s2s', 's2e', '2'],
    ];
    for (const [fs, fe, tag] of segments) {
      const start = entry[fs];
      const end = entry[fe];
      if (!start || !end) continue;
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em2] = end.split(':').map(Number);
      const overnight = eh * 60 + em2 <= sh * 60 + sm;
      const endIso = overnight ? addDaysIso(iso, 1) : iso;
      const summary = roleLabel(entry.role);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${emp.id}-${iso}-s${tag}@morpheus-planning`,
        `DTSTAMP:${nowStamp}`,
        `DTSTART:${icsDateTime(iso, start)}`,
        `DTEND:${icsDateTime(endIso, end)}`,
        foldLine(`SUMMARY:${escapeText(summary)}`),
        foldLine(`DESCRIPTION:${escapeText('Morpheus Experience — ' + summary)}`),
        'LOCATION:42 Boulevard du Président Wilson\\, 67000 Strasbourg',
        'END:VEVENT'
      );
    }
  }

  // --- Absences (événements journée entière) ---
  for (const [key, code] of Object.entries(absences)) {
    const sep = key.indexOf('|');
    const empId = key.slice(0, sep);
    const iso = key.slice(sep + 1);
    if (empId !== emp.id) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${emp.id}-${iso}-abs@morpheus-planning`,
      `DTSTAMP:${nowStamp}`,
      `DTSTART;VALUE=DATE:${icsDate(iso)}`,
      `DTEND;VALUE=DATE:${icsDate(addDaysIso(iso, 1))}`,
      foldLine(`SUMMARY:${escapeText(codeLabel(code))}`),
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');

  const fileName = `${emp.id}.ics`;
  writeFileSync(join(OUT_DIR, fileName), lines.join('\r\n') + '\r\n', 'utf8');
  console.log(`✓ ${fileName}`);
}

console.log(`Terminé : ${employees.length} fichier(s) .ics écrit(s) dans ${OUT_DIR}/`);
