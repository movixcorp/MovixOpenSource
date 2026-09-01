#!/usr/bin/env node
// Génère la source AltStore/SideStore de Movix (movix-ios-source.json).
//
// Toutes les entrées viennent de l'environnement : le job de release du
// workflow ios-unsigned est le seul appelant légitime, et une valeur hors
// format doit faire échouer la publication plutôt que servir une source
// invalide aux utilisateurs qui l'ont ajoutée dans leur store.

import { statSync, writeFileSync } from 'node:fs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function requiredHttps(name) {
  const value = required(name);
  if (!value.startsWith('https://')) {
    fail(`${name} must be an https URL: ${value}`);
  }
  return value;
}

const version = required('IOS_SOURCE_VERSION');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`IOS_SOURCE_VERSION is not a bare semantic version: ${version}`);
}

const buildNumber = required('IOS_SOURCE_BUILD_NUMBER');
if (!/^\d+$/.test(buildNumber)) {
  fail(`IOS_SOURCE_BUILD_NUMBER is not a bare integer: ${buildNumber}`);
}

const minOSVersion = required('IOS_SOURCE_MIN_OS');
if (!/^\d+(\.\d+)*$/.test(minOSVersion)) {
  fail(`IOS_SOURCE_MIN_OS is not a dotted version: ${minOSVersion}`);
}

const ipaPath = required('IOS_SOURCE_IPA_PATH');
let size = 0;
try {
  size = statSync(ipaPath).size;
} catch {
  fail(`IOS_SOURCE_IPA_PATH is not readable: ${ipaPath}`);
}
if (size <= 0) {
  fail(`IOS_SOURCE_IPA_PATH points to an empty file: ${ipaPath}`);
}

const downloadURL = requiredHttps('IOS_SOURCE_DOWNLOAD_URL');
const iconURL = requiredHttps('IOS_SOURCE_ICON_URL');
const notesURL = requiredHttps('IOS_SOURCE_NOTES_URL');
const outputPath = required('IOS_SOURCE_OUTPUT');
const scarletOutputPath = required('IOS_SCARLET_OUTPUT');

// Date de version : celle du commit taggé quand le workflow la fournit
// (déterministe par tag), sinon la date du jour en UTC. Le push d'un tag
// annoté arrive sans head_commit, d'où le repli.
const rawDate = process.env.IOS_SOURCE_DATE ?? '';
const date = /^\d{4}-\d{2}-\d{2}/.test(rawDate)
  ? rawDate.slice(0, 10)
  : new Date().toISOString().slice(0, 10);

const subtitle = 'Films et séries en streaming.';
const versionDescription =
  `Version ${version} (build ${buildNumber}). Notes de version : ${notesURL}`;

// Le domaine tourne sous blocage FAI : la liste vivante est celle de
// VITE_MIRRORS_CONFIG_URL (rentry.co/movix), que l'app et le service worker
// relisent au démarrage. On aligne ce lien à chaque rotation — il n'est lu que
// par l'interface des stores, jamais par l'installation elle-même, donc un
// domaine périmé ici n'empêche personne d'installer l'app.
const website = 'https://movix.online';

const appDescription =
  "Application iOS officielle de Movix : navigation intégrée, lecture " +
  "vidéo native, image dans l'image, Chromecast et DNS sécurisé.";

// « identifier » (source) et « bundleIdentifier » (app) ne doivent JAMAIS
// changer : AltStore et SideStore s'en servent comme clés primaires ; les
// modifier ferait disparaître Movix chez tous les utilisateurs qui ont déjà
// ajouté la source.
const source = {
  name: 'Movix',
  identifier: 'com.movix.source',
  subtitle,
  description:
    "Source officielle de Movix pour AltStore et SideStore. " +
    "Ajoutez-la pour installer l'application iOS et recevoir ses mises à jour.",
  iconURL,
  website,
  tintColor: '#8b5cf6',
  apps: [
    {
      name: 'Movix',
      bundleIdentifier: 'com.movix.app',
      developerName: 'Movix',
      subtitle,
      localizedDescription:
        `${appDescription} L'IPA distribuée ici n'est pas signée : AltStore ` +
        "ou SideStore la signe automatiquement avec votre identifiant Apple " +
        "au moment de l'installation.",
      iconURL,
      tintColor: '#8b5cf6',
      // L'IPA est compilée sans entitlements ni signature : la liste vide est
      // exacte, pas un oubli.
      appPermissions: { entitlements: [], privacy: {} },
      versions: [
        {
          version,
          buildVersion: buildNumber,
          date,
          localizedDescription: versionDescription,
          downloadURL,
          size,
          minOSVersion,
        },
      ],
      // Champs hérités du premier format de source : les anciens AltStore les
      // lisent à la place de « versions ». Duplication exacte de la dernière
      // version, jamais d'autres valeurs.
      version,
      versionDate: date,
      versionDescription,
      downloadURL,
      size,
      beta: false,
    },
  ],
  news: [],
};

// Scarlet lit un format à lui : un bloc META, puis des seaux par catégorie
// (« Tweaked », « Jailbreaks », « Emulators », « Other »). Movix n'est ni un
// tweak ni un émulateur, donc « Other ».
//
// Scarlet signe avec un certificat d'entreprise partagé, pas avec le compte
// Apple de l'utilisateur : rien à payer ni à faire signer côté Movix, mais
// quand Apple révoque ce certificat, toutes les apps installées par Scarlet
// cessent de s'ouvrir d'un coup. C'est pourquoi la source AltStore/SideStore
// reste la voie recommandée, celle-ci n'étant qu'un confort supplémentaire
// pour qui n'a pas d'ordinateur sous la main.
const scarletSource = {
  META: {
    repoName: 'Movix',
    repoIcon: iconURL,
  },
  Other: [
    {
      name: 'Movix',
      version,
      // `down` est l'équivalent Scarlet de `downloadURL` : même IPA, même
      // fichier que celui publié dans la release.
      down: downloadURL,
      category: 'Other',
      description:
        `${appDescription} L'IPA distribuée ici n'est pas signée : Scarlet ` +
        "la signe au moment de l'installation. " +
        versionDescription,
      bundleID: 'com.movix.app',
      icon: iconURL,
      dev: 'Movix',
      contact: { web: website },
    },
  ],
};

writeFileSync(outputPath, `${JSON.stringify(source, null, 2)}\n`);
writeFileSync(scarletOutputPath, `${JSON.stringify(scarletSource, null, 2)}\n`);
console.log(
  `Sources écrites dans ${outputPath} et ${scarletOutputPath} ` +
    `(IPA de ${size} octets, version ${version}, build ${buildNumber})`,
);
