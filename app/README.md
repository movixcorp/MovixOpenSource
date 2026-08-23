# Movix — Application Mobile

Application iOS & Android pour Movix. WebView avec l'extension Movix intégrée (remplacement du userscript Tampermonkey) et changeur DNS 1.1.1.1.

> ⚠️ **Statut iOS : build automatisé non signé**
>
> GitHub Actions compile et teste l'application sur macOS, puis publie une IPA non signée avec sa somme SHA-256. Cette IPA est impossible à installer tant qu'un utilisateur ne l'a pas signée par ses propres moyens.

## Architecture

```
app/
├── src/
│   ├── App.tsx                    # Navigation (Browser + Settings)
│   ├── screens/
│   │   ├── BrowserScreen.tsx      # WebView principal + toolbar
│   │   └── SettingsScreen.tsx     # Toggle DNS + infos extension
│   ├── components/
│   │   ├── WebViewBrowser.tsx     # WebView avec injection userscript
│   │   └── BrowserToolbar.tsx     # Barre de navigation
│   ├── services/
│   │   ├── bridge.ts             # Bridge RN ↔ WebView (remplace GM_xmlhttpRequest)
│   │   └── dns.ts                # Wrapper module DNS natif
│   ├── injection/
│   │   ├── bridge-runtime.ts     # JS injecté dans le WebView (API GM_*)
│   │   ├── inject.ts             # Assembleur bridge + userscript
│   │   └── userscript-source.ts  # Source du userscript (auto-généré)
│   └── config/
│       └── index.ts              # Configuration de l'app
├── android/                       # Code natif Android (VPN DNS)
├── ios/                           # Code natif iOS (NEDNSSettings)
└── scripts/
    └── build-userscript.js        # Génère userscript-source.ts
```

### Comment ça marche

1. **WebView** charge `movix.tax`
2. **Bridge runtime** est injecté AVANT le chargement de la page — fournit `GM_xmlhttpRequest`, `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `unsafeWindow`
3. **Userscript original** est injecté et fonctionne comme dans Tampermonkey
4. Quand le userscript fait une requête via `GM_xmlhttpRequest`, le bridge envoie un message à React Native
5. **React Native** fait la requête HTTP nativement (pas de CORS) et renvoie la réponse
6. **DNS 1.1.1.1** : sur Android via un VPN local, sur iOS via `NEDNSSettingsManager`

## Prérequis

- Node.js 18+
- React Native CLI (`npm install -g @react-native-community/cli`)
- **Android** : Android Studio, JDK 17, Android SDK 35
- **iOS** : Xcode 15+, CocoaPods (`gem install cocoapods`)

## Installation

```bash
cd app

# Installer les dépendances
npm install

# Générer le userscript source
node scripts/build-userscript.js

# iOS seulement
cd ios && pod install && cd ..
```

## Lancement

```bash
# Android
npm run android

# iOS
npm run ios

# Metro bundler seul
npm run start
```

## Build de production

### Android (APK / AAB)

```bash
cd android
./gradlew assembleRelease    # APK
./gradlew bundleRelease      # AAB (Play Store)
```

L'APK sera dans `android/app/build/outputs/apk/release/`.

### iOS

Le workflow GitHub Actions **iOS unsigned IPA** produit un artefact nommé `Movix-unsigned-<version>-<run-number>`. Depuis la racine du dépôt, remplacez les valeurs entre chevrons par celles du run à télécharger :

```bash
gh run download <run-id> \
  --name "Movix-unsigned-<version>-<run-number>" \
  --dir Movix-unsigned-<version>-<run-number>
cd Movix-unsigned-<version>-<run-number>
shasum -a 256 -c Movix-unsigned.ipa.sha256
```

Le téléchargement contient `Movix-unsigned.ipa` et `Movix-unsigned.ipa.sha256`. **L'IPA est non signée et son installation est impossible tant qu'un utilisateur ne l'a pas signée par ses propres moyens.**

## DNS 1.1.1.1

### Android
- Utilise `VpnService` pour créer un VPN local
- Seules les requêtes DNS sont redirigées vers 1.1.1.1
- Aucune donnée ne transite par un serveur tiers
- L'utilisateur doit approuver la connexion VPN

### iOS
- Utilise `NEDNSSettingsManager` (iOS 14+)
- DNS-over-HTTPS vers `cloudflare-dns.com`
- Nécessite l'entitlement `com.apple.developer.networking.dns-settings`
- Requiert un profil de provisioning avec cette capability

## Mise à jour du userscript

Quand le userscript (`../userscript/movix.user.js`) est modifié :

```bash
node scripts/build-userscript.js
```

Puis rebuild l'app.

## Notes

- Le `DnsPackage.kt` doit être enregistré dans `MainApplication.kt` (ajouté au `getPackages()`)
- Pour iOS, le bridging header doit pointer vers `Movix-Bridging-Header.h`
- L'app exclut son propre trafic du VPN DNS pour éviter les boucles
- Le mode audio en arrière-plan est activé pour la lecture vidéo continue
