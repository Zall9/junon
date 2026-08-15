# Mission : construire un protocole commun entre agents IA et API natives d’IDE

Tu dois concevoir et implémenter un projet open source complet permettant à un agent IA, notamment Serena, de communiquer avec VS Code et les IDE JetBrains à travers un protocole commun, stable, sécurisé et indépendant des IDE.

Le projet s’appellera provisoirement **IDE Bridge**.

Le protocole s’appellera **IDE Bridge Protocol**, abrégé **IDEBP**.

Tu dois travailler de manière autonome jusqu’à obtenir un MVP réellement exécutable et testé.

Ne te limite pas à produire une architecture théorique ou des interfaces non fonctionnelles.

---

# 1. Objectif produit

Construire la chaîne suivante :

```text
Agent IA / MCP client
        │
        ▼
Serena ou autre intégration
        │
        │ IDE Bridge Protocol
        ▼
IDE Bridge Daemon
        │
        ├── Adaptateur VS Code
        │       └── API natives VS Code et providers installés
        │
        └── Adaptateur JetBrains
                └── PSI, indexes et API natives de refactoring
```

Le système doit permettre à un agent de :

* découvrir les IDE ouverts ;
* découvrir leurs workspaces ;
* connaître les capacités réelles de chaque IDE et langage ;
* lire les symboles d’un document ;
* rechercher des symboles dans un workspace ;
* trouver définitions, références et implémentations ;
* obtenir les diagnostics ;
* préparer un renommage sémantique ;
* prévisualiser les changements ;
* appliquer les changements de manière contrôlée ;
* détecter les documents devenus obsolètes ;
* fonctionner avec plusieurs fenêtres et plusieurs workspaces ;
* servir ultérieurement de backend à Serena.

Le protocole ne doit pas être spécifique à Serena.

---

# 2. Contraintes non négociables

## 2.1 Sécurité Git

Tu peux modifier les fichiers du working tree.

Tu ne dois jamais :

* créer un commit ;
* modifier un commit ;
* pousser une branche ;
* créer une release ;
* publier un package ;
* créer une pull request ou merge request ;
* modifier un dépôt distant.

À la fin, laisse tous les changements non commités et fournis un récapitulatif précis.

## 2.2 Qualité

Tu ne dois jamais déclarer une fonctionnalité terminée sans avoir exécuté les tests correspondants.

Pour chaque phase :

1. implémenter ;
2. formatter ;
3. lancer le lint ;
4. lancer le type checking ;
5. lancer les tests unitaires ;
6. lancer les tests d’intégration disponibles ;
7. corriger les erreurs ;
8. documenter le résultat.

Les mocks sont autorisés dans les tests unitaires, mais le MVP final doit inclure au moins un chemin d’intégration réel pour chaque IDE.

## 2.3 Décisions

Quand une décision mineure est nécessaire, choisis la solution la plus simple et documente-la.

Ne demande pas de validation pour les choix ordinaires.

Crée un ADR lorsqu’une décision affecte :

* le protocole ;
* la compatibilité future ;
* la sécurité ;
* le modèle de transactions ;
* le transport ;
* la représentation des symboles ;
* les opérations de modification.

Ne bloque que lorsqu’une contrainte externe empêche réellement de continuer.

## 2.4 Portée initiale

Le MVP doit prendre en charge :

* Linux ;
* macOS ;
* VS Code desktop ;
* IntelliJ Platform desktop ;
* projets locaux ;
* workspaces VS Code simples et multi-root.

Windows, WSL, Dev Containers, SSH et JetBrains Remote Development doivent être pris en compte dans la conception, documentés et représentés dans les types, mais leur support complet peut venir après le MVP.

---

# 3. Choix techniques initiaux

Utilise cette stack, sauf incompatibilité démontrée et documentée dans un ADR.

## Monorepo

* pnpm workspaces ;
* TypeScript strict ;
* Node.js LTS ;
* ESLint ;
* Prettier ;
* Vitest ;
* JSON Schema 2020-12 ;
* GitHub Actions pour la CI, sans publication.

## Bridge daemon

* TypeScript ;
* Node.js ;
* JSON-RPC 2.0 ;
* WebSocket ;
* écoute uniquement sur loopback ;
* port dynamique ;
* validation runtime de tous les messages ;
* logs structurés ;
* aucune télémétrie.

## Extension VS Code

* TypeScript ;
* API officielle VS Code ;
* extension host de type workspace ;
* tests d’extension officiels ;
* aucune écriture directe contournant `WorkspaceEdit`.

## Plugin JetBrains

* Kotlin ;
* Gradle ;
* IntelliJ Platform Plugin SDK ;
* `kotlinx.serialization` ;
* services au niveau application et projet ;
* PSI ;
* indexes ;
* smart pointers ;
* read actions non bloquantes ;
* write commands pour les modifications ;
* aucun travail PSI lourd sur l’EDT.

## Intégration Serena

* Python ;
* Python 3.12 ou version imposée par Serena ;
* modèles typés ;
* client JSON-RPC ;
* backend séparé appelé `ide_bridge` ;
* aucun couplage de Serena dans le protocole ou les plugins IDE.

---

# 4. Arborescence attendue

Construis progressivement cette structure :

```text
ide-bridge/
├── AGENTS.md
├── README.md
├── LICENSE
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.js
├── prettier.config.js
│
├── docs/
│   ├── IMPLEMENTATION_PLAN.md
│   ├── PROTOCOL.md
│   ├── SECURITY.md
│   ├── ARCHITECTURE.md
│   ├── REMOTE_DEVELOPMENT.md
│   ├── SERENA_INTEGRATION.md
│   └── adr/
│       ├── 0001-json-rpc-websocket.md
│       ├── 0002-document-revisions.md
│       ├── 0003-symbol-handles.md
│       └── 0004-two-phase-edits.md
│
├── packages/
│   ├── protocol/
│   │   ├── schemas/
│   │   ├── fixtures/
│   │   ├── src/
│   │   └── tests/
│   │
│   ├── bridge-daemon/
│   │   ├── src/
│   │   └── tests/
│   │
│   ├── bridge-client/
│   │   ├── src/
│   │   └── tests/
│   │
│   ├── vscode-extension/
│   │   ├── src/
│   │   ├── test/
│   │   └── package.json
│   │
│   └── conformance/
│       ├── src/
│       ├── fixtures/
│       └── tests/
│
├── jetbrains-plugin/
│   ├── build.gradle.kts
│   ├── settings.gradle.kts
│   └── src/
│       ├── main/
│       └── test/
│
├── integrations/
│   └── serena/
│       ├── README.md
│       ├── ide_bridge/
│       └── tests/
│
├── examples/
│   ├── typescript-project/
│   ├── php-project/
│   └── java-project/
│
└── scripts/
    ├── check-protocol-fixtures.ts
    ├── generate-types.ts
    └── run-conformance.ts
```

Adapte les détails lorsque les conventions des SDK l’exigent, mais conserve la séparation logique.

---

# 5. Travail initial obligatoire

Avant toute implémentation importante :

1. inspecte entièrement le dépôt ;
2. identifie les éventuelles contraintes existantes ;
3. crée `docs/IMPLEMENTATION_PLAN.md` ;
4. crée `AGENTS.md` ;
5. crée les premiers ADR ;
6. liste les risques ;
7. définis les commandes de validation ;
8. crée la base du monorepo.

Le plan doit contenir :

* les phases ;
* leurs dépendances ;
* leurs critères d’acceptation ;
* les commandes de tests ;
* les fonctionnalités reportées ;
* les risques techniques.

Ne reste ensuite pas bloqué dans la documentation : commence l’implémentation.

---

# 6. Contenu attendu de `AGENTS.md`

Crée un `AGENTS.md` contenant au minimum ces règles :

```markdown
# IDE Bridge development rules

## General

- Read the relevant protocol schemas and ADRs before changing public contracts.
- Keep protocol packages independent from VS Code, JetBrains and Serena.
- Prefer small, composable components.
- Do not hide unsupported capabilities behind approximate implementations.
- Never describe a textual edit as semantic.
- Never commit, push, publish or create releases.

## Protocol

- JSON Schema is the canonical wire-contract definition.
- Every public request, response, event and error must have a schema.
- All protocol changes require fixtures and compatibility tests.
- New breaking changes require a protocol version decision and ADR.
- URI values must not be converted to local paths without an explicit mapper.
- Every edit must carry revision preconditions.

## TypeScript validation

Run:

- pnpm format:check
- pnpm lint
- pnpm typecheck
- pnpm test

## JetBrains validation

Run the Gradle formatting, static checks and tests defined by the plugin.

## Changes

- Do not apply raw offset-based edits when a semantic or syntax-aware operation exists.
- Write operations must use prepare/apply.
- Plans must expire and be rejected when their preconditions are stale.
- Do not block the VS Code extension host or JetBrains EDT.
```

Ajoute les commandes finales exactes après avoir créé les scripts.

---

# 7. Spécification du protocole

## 7.1 Principes

IDEBP doit être :

* indépendant des IDE ;
* indépendant des langages ;
* versionné ;
* orienté capacités ;
* compatible avec plusieurs workspaces ;
* compatible avec les documents non sauvegardés ;
* conscient des révisions ;
* conçu pour des opérations annulables ;
* explicite sur le niveau de garantie d’une opération.

Il ne doit pas être présenté comme un remplacement de LSP.

Il peut réutiliser les concepts suivants :

* URI ;
* position ;
* range ;
* diagnostic ;
* text edit ;
* workspace edit.

Mais il doit ajouter :

* adaptateur ;
* workspace ;
* racine ;
* session ;
* capacité ;
* garantie ;
* document revision ;
* symbol handle ;
* symbol locator ;
* edit plan ;
* précondition ;
* atomicité ;
* readiness ;
* undo token.

## 7.2 Transport

Implémente :

```text
JSON-RPC 2.0 over WebSocket
```

Le daemon :

* écoute sur `127.0.0.1` et/ou `::1` ;
* utilise un port dynamique par défaut ;
* génère un secret aléatoire d’au moins 256 bits ;
* écrit un fichier de découverte privé ;
* refuse toute connexion non authentifiée ;
* limite la taille des messages ;
* applique des timeouts ;
* supporte l’annulation des requêtes ;
* gère heartbeat et expiration des sessions.

Prévois une abstraction de transport pour permettre ultérieurement :

* Unix domain socket ;
* Windows named pipe ;
* tunnel distant.

## 7.3 Fichier de découverte

Utilise une structure équivalente à :

```json
{
  "protocolVersion": "0.1.0",
  "endpoint": "ws://127.0.0.1:41731/rpc",
  "token": "base64-secret",
  "pid": 12345,
  "startedAt": "2026-08-01T12:00:00Z"
}
```

Le fichier doit être créé avec les permissions les plus restrictives possibles.

Ne logue jamais le token.

## 7.4 Négociation de version

Au handshake, chaque client annonce :

```json
{
  "protocol": {
    "minimum": "0.1.0",
    "maximum": "0.1.0"
  }
}
```

Le daemon sélectionne une version commune ou refuse proprement la session.

## 7.5 Encodage des positions

Prends en charge explicitement :

```text
utf-16
```

Prépare le protocole pour :

```text
utf-8
utf-32
```

Chaque adaptateur annonce les encodages qu’il supporte.

Tous les ranges doivent indiquer ou hériter clairement de l’encodage utilisé.

---

# 8. Modèle de capacités

Définis un modèle de capacité structuré.

Exemple :

```json
{
  "document.symbols": {
    "support": "native",
    "guarantee": "semantic"
  },
  "refactor.rename": {
    "support": "provider",
    "guarantee": "semantic",
    "preview": true
  },
  "symbol.editRegion": {
    "support": "unavailable"
  },
  "workspace.applyEdit": {
    "support": "native",
    "atomicity": "text-only"
  }
}
```

## Valeurs de `support`

```text
native
provider
adapter
unavailable
```

## Valeurs de `guarantee`

```text
semantic
syntactic
anchored-text
raw-text
```

## Règles

* `semantic` : résolution ou refactoring géré par l’IDE ou son provider sémantique ;
* `syntactic` : opération garantie par un parser ou un arbre syntaxique ;
* `anchored-text` : opération textuelle protégée par hash et contexte ;
* `raw-text` : opération par range brut sans garantie structurelle.

Une capacité `raw-text` ne doit jamais être présentée comme sémantique.

Le backend Serena devra pouvoir masquer les outils qui ne sont pas supportés.

---

# 9. Documents et révisions

Définis une référence de document contenant au minimum :

```json
{
  "workspaceId": "ws_42",
  "rootId": "root_api",
  "uri": "file:///home/user/project/src/service.ts",
  "logicalPath": "src/service.ts",
  "revision": {
    "editorVersion": 27,
    "contentHash": "sha256:...",
    "workspaceEpoch": 148
  }
}
```

## Contraintes

* `uri` est l’identité principale ;
* `logicalPath` est informatif ;
* ne suppose jamais que deux processus voient le même chemin OS ;
* distingue le contenu en mémoire du contenu sauvegardé ;
* calcule un hash stable ;
* incrémente l’epoch lorsque les caches sémantiques peuvent devenir invalides ;
* rejette toute opération préparée sur une révision obsolète.

Retourne une erreur `STALE_DOCUMENT` avec la révision actuelle.

---

# 10. Symboles

Un symbole doit posséder :

1. un handle opaque, rapide et temporaire ;
2. un locator persistant permettant de le retrouver.

Exemple :

```json
{
  "handle": {
    "adapterId": "adapter_1",
    "sessionId": "session_1",
    "id": "sym_123",
    "validUntilEpoch": 151
  },
  "locator": {
    "documentUri": "file:///project/src/service.ts",
    "name": "update",
    "qualifiedName": "StreamService.update",
    "kind": "method",
    "containerName": "StreamService",
    "selectionRange": {
      "start": {
        "line": 10,
        "character": 2
      },
      "end": {
        "line": 10,
        "character": 8
      }
    },
    "fingerprint": "sha256:..."
  }
}
```

## Contraintes

* ne considère pas un nom comme une identité suffisante ;
* supporte les overloads ;
* supporte les symboles imbriqués ;
* supporte les fichiers contenant plusieurs symboles de même nom ;
* invalide les handles lors des changements pertinents ;
* tente une relocalisation contrôlée avant de retourner `STALE_SYMBOL` ;
* retourne `AMBIGUOUS_SYMBOL` avec les candidats au lieu de sélectionner arbitrairement.

---

# 11. Méthodes MVP du protocole

Implémente les méthodes suivantes.

## Lifecycle

```text
ide/register
ide/unregister
ide/ping
ide/getCapabilities
```

## Workspaces

```text
workspace/list
workspace/get
workspace/getStatus
```

## Documents

```text
document/read
document/getRevision
document/getSymbols
```

## Symboles

```text
workspace/searchSymbols
symbol/resolveAt
symbol/getDefinition
symbol/getReferences
symbol/getImplementations
```

## Diagnostics

```text
diagnostics/getSnapshot
```

## Refactoring

```text
refactor/prepareRename
workspace/applyPlan
workspace/discardPlan
workspace/undo
```

## Administration locale

```text
bridge/getStatus
bridge/listAdapters
bridge/listSessions
```

---

# 12. Notifications MVP

Implémente les notifications suivantes :

```text
adapter/capabilitiesChanged
adapter/disconnected

workspace/opened
workspace/closed
workspace/rootsChanged
workspace/readinessChanged

document/opened
document/changed
document/saved
document/closed
document/renamed
document/deleted

diagnostics/changed
```

Un changement de document doit au minimum invalider les plans et handles concernés.

Il n’est pas nécessaire d’envoyer tous les changements de texte au daemon durant le MVP.

---

# 13. Readiness et indexation

Définis les états :

```text
initializing
indexing
ready
degraded
disconnected
```

Exemple :

```json
{
  "workspaceId": "ws_42",
  "state": "indexing",
  "capabilitiesUnavailable": [
    "workspace.searchSymbols",
    "symbol.getReferences",
    "refactor.rename"
  ],
  "progress": {
    "known": false
  }
}
```

Une opération dépendant des indexes doit retourner :

```text
INDEX_NOT_READY
```

L’erreur doit être marquée comme réessayable.

---

# 14. Erreurs normalisées

Implémente au minimum :

```text
INVALID_REQUEST
UNSUPPORTED_PROTOCOL_VERSION
AUTHENTICATION_FAILED
WORKSPACE_NOT_FOUND
DOCUMENT_NOT_FOUND
ADAPTER_NOT_FOUND
ADAPTER_DISCONNECTED
CAPABILITY_UNAVAILABLE
INDEX_NOT_READY
STALE_DOCUMENT
STALE_SYMBOL
AMBIGUOUS_SYMBOL
INVALID_IDENTIFIER
PRECONDITION_FAILED
PLAN_NOT_FOUND
PLAN_EXPIRED
PROVIDER_FAILED
TIMEOUT
CANCELLED
PERMISSION_DENIED
PARTIAL_APPLY
INTERNAL_ERROR
```

Chaque erreur doit contenir :

* un code stable ;
* un message humain ;
* un caractère réessayable ou non ;
* des données structurées lorsque nécessaire ;
* aucune stack trace sensible envoyée par défaut au client.

---

# 15. Modèle prepare/apply

Toute modification sémantique doit utiliser deux phases.

## Phase de préparation

Exemple :

```text
refactor/prepareRename
```

Entrée :

```json
{
  "workspaceId": "ws_42",
  "symbol": {
    "handle": {
      "id": "sym_123"
    }
  },
  "newName": "updateStream",
  "options": {
    "includeComments": false,
    "includeStrings": false
  }
}
```

Sortie :

```json
{
  "planId": "plan_123",
  "expiresAt": "2026-08-01T13:30:00Z",
  "operation": "rename",
  "guarantee": "semantic",
  "atomicity": "text-only",
  "preconditions": [
    {
      "type": "documentRevision",
      "uri": "file:///project/src/service.ts",
      "editorVersion": 27,
      "contentHash": "sha256:..."
    }
  ],
  "changes": [
    {
      "kind": "textEdit",
      "uri": "file:///project/src/service.ts",
      "editCount": 2
    }
  ],
  "warnings": []
}
```

## Phase d’application

```text
workspace/applyPlan
```

Avant d’appliquer :

* vérifier l’expiration ;
* vérifier la session ;
* vérifier le workspace ;
* vérifier toutes les préconditions ;
* vérifier les permissions ;
* vérifier les révisions ;
* empêcher la réutilisation du plan.

Après application :

* retourner les documents modifiés ;
* retourner les hashes avant/après ;
* invalider les handles concernés ;
* récupérer les diagnostics après modification lorsque demandé ;
* retourner un `undoToken` lorsque l’IDE le permet.

## Plans

Un plan doit être :

* lié à un adaptateur ;
* lié à une session ;
* lié à un workspace ;
* non réutilisable après application ;
* automatiquement expiré ;
* supprimable explicitement ;
* invalidé lors d’un changement pertinent.

---

# 16. Bridge daemon

Construis un daemon fonctionnel avec les responsabilités suivantes :

## Session registry

Conserver :

* adaptateurs ;
* sessions ;
* workspaces ;
* capacités ;
* état de readiness ;
* heartbeat ;
* timestamp de dernière activité.

## Routing

Router chaque requête vers le bon adaptateur en utilisant :

* `adapterId` ;
* `workspaceId` ;
* `sessionId`.

Ne route jamais une opération d’un workspace vers un autre adaptateur sans décision explicite.

## Plan store

Conserver en mémoire les plans MVP.

Prévoir une interface permettant un autre stockage plus tard.

Le stockage doit gérer :

* expiration ;
* invalidation ;
* consommation atomique ;
* recherche par workspace ;
* nettoyage périodique.

## CLI

Fournis au minimum :

```bash
ide-bridge daemon
ide-bridge status
ide-bridge adapters
ide-bridge workspaces
ide-bridge doctor
```

`doctor` doit vérifier :

* fichier de découverte ;
* permissions ;
* disponibilité du port ;
* état des adaptateurs ;
* compatibilité de protocole ;
* sessions expirées.

## Observabilité

Ajoute des logs structurés avec :

* niveau ;
* composant ;
* request ID ;
* session ID lorsque pertinent ;
* durée ;
* résultat.

Ne logue jamais :

* secret d’authentification ;
* contenu complet des fichiers ;
* texte complet des remplacements ;
* données sensibles des diagnostics.

---

# 17. Client TypeScript commun

Crée `packages/bridge-client`.

Il doit fournir :

* découverte du daemon ;
* authentification ;
* reconnexion ;
* appels JSON-RPC typés ;
* notifications ;
* timeouts ;
* annulation ;
* vérification de version ;
* validation runtime ;
* erreurs typées.

L’extension VS Code doit utiliser ce client.

Ne duplique pas le code JSON-RPC dans l’extension.

---

# 18. Extension VS Code

Construis une extension réellement installable en développement.

## Activation

L’extension doit :

1. découvrir ou lancer le daemon selon la configuration ;
2. s’authentifier ;
3. enregistrer l’adaptateur ;
4. enregistrer les workspaces ;
5. annoncer ses capacités ;
6. écouter les événements VS Code ;
7. se désenregistrer proprement à la fermeture.

## Workspace trust

Lorsque le workspace n’est pas trusted :

* autoriser les opérations de lecture sûres ;
* désactiver les opérations d’écriture ;
* annoncer les capacités modifiées ;
* retourner `PERMISSION_DENIED` en cas de modification demandée.

## Mapping des opérations

Utilise les providers VS Code pour :

```text
document/getSymbols
workspace/searchSymbols
symbol/getDefinition
symbol/getReferences
symbol/getImplementations
refactor/prepareRename
```

Utilise les API de diagnostics VS Code pour :

```text
diagnostics/getSnapshot
```

Utilise `WorkspaceEdit` et `workspace.applyEdit` pour :

```text
workspace/applyPlan
```

## Capacités dynamiques

Ne suppose pas qu’un provider existe.

Pour chaque opération :

* détecte l’absence de provider ;
* retourne `CAPABILITY_UNAVAILABLE` ;
* mets à jour les capacités lorsque c’est pertinent ;
* ne remplace pas silencieusement une opération sémantique par un grep.

## Documents non sauvegardés

Les opérations doivent utiliser le contenu du document ouvert dans VS Code.

Le hash de révision doit refléter le buffer en mémoire, pas uniquement le fichier sur disque.

## Événements

Connecte au minimum :

* ouverture ;
* changement ;
* sauvegarde ;
* fermeture ;
* renommage ;
* suppression ;
* changement des dossiers du workspace ;
* changement de trust.

## Configuration

Expose des settings pour :

* démarrage automatique du daemon ;
* endpoint manuel ;
* chemin du fichier de découverte ;
* niveau de log ;
* timeout des providers.

Ne permet pas de configurer une écoute réseau publique dans le MVP.

---

# 19. Plugin JetBrains

Construis un plugin installable en sandbox de développement.

## Architecture interne

Crée au minimum :

* un service application pour la connexion au daemon ;
* un service projet pour l’enregistrement du workspace ;
* un registre de symbol handles ;
* un routeur de requêtes ;
* un mapper PSI vers les DTO IDEBP ;
* un gestionnaire de readiness ;
* un gestionnaire de plans ;
* un composant de diagnostics minimal.

## Threading

Règles absolues :

* aucune recherche globale PSI lourde sur l’EDT ;
* utiliser des read actions adaptées ;
* attendre le smart mode pour les indexes ;
* utiliser une write command pour les modifications ;
* vérifier la validité des éléments PSI ;
* annuler les tâches lorsque le projet est fermé.

## Symbol handles

Utilise :

* pointer de symbole lorsque disponible et stable ;
* smart PSI element pointer comme solution compatible ;
* locator IDEBP comme fallback.

N’expose jamais directement un objet PSI dans le protocole.

## Readiness

Mappe l’état JetBrains :

* ouverture du projet ;
* dumb mode ;
* smart mode ;
* fermeture du projet.

Pendant le dumb mode, désactive les capacités nécessitant les indexes.

## Opérations MVP

Implémente réellement :

```text
document/getSymbols
workspace/searchSymbols
symbol/resolveAt
symbol/getDefinition
symbol/getReferences
symbol/getImplementations
diagnostics/getSnapshot
refactor/prepareRename
workspace/applyPlan
```

Commence par Java/Kotlin pour valider le plugin.

Structure les abstractions pour ajouter PHP, JavaScript et TypeScript plus tard sans mettre de logique spécifique au langage dans le protocole.

## Renommage

Le renommage doit utiliser les API de refactoring JetBrains.

La préparation doit produire un aperçu sérialisable des fichiers touchés.

L’application doit :

* vérifier les préconditions ;
* exécuter le refactoring dans une write command ;
* gérer l’annulation ;
* retourner le résultat ;
* ne pas bloquer l’EDT plus longtemps que nécessaire.

## Diagnostics

Pour le MVP, une implémentation limitée mais réelle est acceptable.

Documente précisément :

* la source des diagnostics ;
* les limites ;
* le moment où ils sont disponibles ;
* leur différence avec une inspection complète.

---

# 20. Édition symbolique future

Ne mets pas `replaceSymbolBody` dans le MVP générique.

Documente et prépare plutôt ces méthodes futures :

```text
symbol/getEditableRegions
symbol/prepareRegionEdit
```

Une région devra indiquer :

```text
wholeDeclaration
body
expression
statementList
initializer
signature
```

Chaque région devra fournir son niveau de garantie.

Le remplacement devra préciser son format :

```text
regionContent
wholeDeclaration
expression
statementList
```

Aucun adaptateur ne devra annoncer cette capacité tant qu’il ne peut pas garantir que le remplacement ne duplique ni ne supprime :

* modificateurs ;
* annotations ;
* attributs ;
* mots-clés ;
* déclarations de type ;
* signatures ;
* accolades.

---

# 21. Intégration Serena

Crée une intégration isolée dans :

```text
integrations/serena
```

Deux modes sont acceptables :

1. patch propre destiné à un fork de Serena ;
2. package Python autonome contenant le backend et des instructions d’intégration.

## Backend

Ajoute un backend conceptuel :

```yaml
language_backend: ide_bridge
```

Configuration proposée :

```yaml
ide_bridge:
  discovery_file: auto
  workspace: auto
  request_timeout_seconds: 30
  prefer_adapter:
    - jetbrains
    - vscode
```

## Comportement

Le backend doit :

* se connecter au daemon ;
* lister les workspaces ;
* sélectionner le workspace correspondant au projet Serena ;
* vérifier les URI et racines ;
* récupérer les capacités ;
* mapper les appels Serena vers IDEBP ;
* convertir proprement les réponses ;
* gérer les erreurs réessayables ;
* ne pas supposer que toutes les opérations sont disponibles.

## Exposition dynamique des outils

Lorsque possible, l’intégration doit exposer ou désactiver les outils Serena selon les capacités.

Exemples :

```text
refactor.rename semantic disponible
→ activer rename_symbol

symbol.references disponible
→ activer find_referencing_symbols

symbol.editRegion indisponible
→ ne pas présenter replace_symbol_body comme opération sûre
```

Si Serena ne permet pas cette génération dynamique sans modification majeure, documente la limite et implémente le comportement le plus sûr.

## Fallback

Ne bascule pas automatiquement vers une modification textuelle lorsque l’adaptateur refuse une opération sémantique.

Un fallback doit être :

* explicitement configuré ;
* annoncé au consommateur ;
* accompagné de son niveau de garantie.

---

# 22. Conformance suite

Construis une suite de conformité indépendante des IDE.

Elle doit permettre de tester n’importe quel adaptateur IDEBP.

## Scénarios obligatoires

### Enregistrement

* handshake valide ;
* version incompatible ;
* token invalide ;
* capacités valides ;
* capability inconnue.

### Workspaces

* un workspace ;
* plusieurs workspaces ;
* multi-root ;
* workspace fermé ;
* deux IDE sur le même projet.

### Documents

* fichier sauvegardé ;
* buffer non sauvegardé ;
* changement après lecture ;
* URI contenant espaces et caractères Unicode ;
* CRLF ;
* caractère Unicode hors BMP pour tester UTF-16.

### Symboles

* symbole unique ;
* symboles homonymes ;
* méthode overloadée ;
* symbole imbriqué ;
* handle expiré ;
* relocalisation réussie ;
* relocalisation ambiguë.

### Références

* aucune référence ;
* références dans un fichier ;
* références multi-fichiers ;
* résultat partiel ;
* provider indisponible ;
* timeout.

### Rename

* rename mono-fichier ;
* rename multi-fichiers ;
* nom invalide ;
* collision ;
* document modifié après préparation ;
* plan expiré ;
* plan appliqué deux fois ;
* adaptateur déconnecté ;
* opération annulée ;
* diagnostics avant/après.

### Sécurité

* connexion non locale refusée ;
* token absent ;
* fichier de découverte trop permissif ;
* message surdimensionné ;
* données secrètes absentes des logs.

---

# 23. Fixtures

Crée de petits projets déterministes.

## TypeScript

Inclure :

* classe ;
* interface ;
* implémentation ;
* références multi-fichiers ;
* overload ou signatures multiples ;
* symbole Unicode ;
* tests de renommage.

## Java

Inclure :

* interface ;
* classe abstraite ;
* implémentation ;
* méthode override ;
* références ;
* rename multi-fichiers.

## PHP

Créer la fixture et les contrats attendus, même si l’intégration IDE réelle PHP n’est pas terminée dans le MVP.

Inclure :

* namespace ;
* classe ;
* trait ;
* méthode ;
* attribut PHP ;
* références ;
* symbole de même nom dans deux namespaces.

---

# 24. Stratégie de tests

## Protocol package

Tester :

* validation de chaque schema ;
* requêtes et réponses d’exemple ;
* erreurs ;
* compatibilité des fixtures ;
* rejet des propriétés invalides ;
* sérialisation aller-retour.

## Daemon

Tester :

* auth ;
* sessions ;
* heartbeat ;
* routing ;
* expiration ;
* plan store ;
* invalidation ;
* reconnect ;
* timeouts ;
* cancellation ;
* logs redacted.

## VS Code

Tester :

* activation ;
* register ;
* workspace discovery ;
* document symbols ;
* references ;
* diagnostics ;
* prepare rename ;
* stale revision ;
* apply edit ;
* workspace non trusted lorsque testable.

## JetBrains

Tester :

* service lifecycle ;
* project registration ;
* dumb/smart mode ;
* PSI symbol mapping ;
* references ;
* pointer invalidation ;
* rename ;
* fermeture de projet ;
* absence de travail lourd sur l’EDT.

## Serena

Tester :

* connexion ;
* workspace matching ;
* mapping des méthodes ;
* capacités absentes ;
* erreur réessayable ;
* adaptateur déconnecté ;
* URI distante préservée.

## End-to-end

Créer au moins ces tests :

```text
VS Code adapter → daemon → client de test
JetBrains adapter → daemon → client de test
```

Puis, lorsque possible :

```text
Serena integration → daemon → adaptateur réel
```

---

# 25. Remote development

Crée `docs/REMOTE_DEVELOPMENT.md`.

Le document doit couvrir :

* VS Code local ;
* VS Code SSH ;
* VS Code WSL ;
* Dev Containers ;
* Codespaces ;
* JetBrains Remote Development ;
* daemon local ;
* daemon distant ;
* agent local ;
* agent distant ;
* URI non locales ;
* tunnels ;
* différences de chemins ;
* sécurité du transport.

Principe architectural :

```text
L’adaptateur, le daemon et l’agent devraient tourner dans le même environnement que le workspace lorsque cela est possible.
```

Lorsque ce n’est pas possible :

* conserver les URI de l’environnement source ;
* utiliser un mapping explicite ;
* ne jamais deviner un mapping ;
* annoncer la topologie dans le handshake.

Définis dans les types :

```text
hostKind:
  local
  remote-workspace
  web
  gateway
```

Et :

```text
environmentKind:
  local
  ssh
  wsl
  dev-container
  codespace
  jetbrains-remote
  unknown
```

---

# 26. Sécurité

Crée `docs/SECURITY.md`.

Le threat model doit couvrir :

* processus local malveillant ;
* vol du token ;
* fichier de découverte accessible ;
* websocket exposé publiquement ;
* extension IDE compromise ;
* client MCP malveillant ;
* opérations sur le mauvais workspace ;
* modification d’un document devenu obsolète ;
* replay d’un plan ;
* fuite du contenu source dans les logs ;
* denial of service local ;
* messages JSON malformés ;
* URI path traversal ;
* symlinks ;
* workspace non trusted.

Le daemon ne doit exposer aucune méthode permettant :

* d’exécuter une commande shell arbitraire ;
* d’exécuter une commande IDE arbitraire ;
* d’évaluer du JavaScript ou Kotlin arbitraire ;
* d’accéder à un fichier hors workspace sans permission explicite ;
* de désactiver silencieusement les contrôles de trust.

---

# 27. CI

Crée une CI non destructive.

Elle doit exécuter :

* format check ;
* lint ;
* typecheck ;
* tests TypeScript ;
* validation des schemas ;
* tests de conformité ;
* build extension VS Code ;
* tests Gradle du plugin JetBrains ;
* build du plugin JetBrains ;
* tests Python Serena ;
* détection des secrets accidentels ;
* vérification que les fichiers générés sont à jour.

Aucune étape ne doit publier de package ou release.

---

# 28. Phases d’exécution

## Phase 0 — Fondation

Livrables :

* plan ;
* `AGENTS.md` ;
* ADR ;
* monorepo ;
* scripts ;
* CI minimale.

Critères d’acceptation :

* installation propre ;
* format/lint/typecheck/tests de base verts ;
* documentation des commandes.

## Phase 1 — Protocole

Livrables :

* schemas ;
* types ;
* fixtures ;
* erreurs ;
* capacités ;
* documents ;
* symboles ;
* plans ;
* notifications.

Critères :

* tous les exemples valides ;
* exemples invalides rejetés ;
* tests de sérialisation verts ;
* protocole documenté.

## Phase 2 — Daemon

Livrables :

* WebSocket JSON-RPC ;
* auth ;
* discovery ;
* registry ;
* routing ;
* plan store ;
* CLI ;
* doctor.

Critères :

* plusieurs adaptateurs simulés ;
* routage multi-workspace ;
* expiration ;
* reconnexion ;
* tests de sécurité verts.

## Phase 3 — Adaptateur VS Code

Livrables :

* extension ;
* connexion daemon ;
* découverte workspaces ;
* lecture sémantique ;
* diagnostics ;
* rename ;
* apply ;
* événements.

Critères :

* scénario end-to-end TypeScript ;
* rename multi-fichiers ;
* stale document rejeté ;
* extension buildable.

## Phase 4 — Adaptateur JetBrains

Livrables :

* plugin ;
* connexion ;
* lifecycle projet ;
* readiness ;
* PSI ;
* références ;
* diagnostics minimum ;
* rename.

Critères :

* scénario end-to-end Java ;
* dumb mode géré ;
* rename multi-fichiers ;
* plugin buildable ;
* tests verts.

## Phase 5 — Conformance

Livrables :

* runner ;
* scénarios communs ;
* rapport ;
* fixtures Unicode et révisions.

Critères :

* VS Code passe la matrice des capacités annoncées ;
* JetBrains passe la matrice des capacités annoncées ;
* aucune capacité absente n’est testée comme supportée.

## Phase 6 — Serena

Livrables :

* client Python ;
* backend ;
* configuration ;
* mapping ;
* tests ;
* documentation.

Critères :

* Serena peut sélectionner un workspace ;
* Serena peut trouver un symbole ;
* Serena peut trouver des références ;
* Serena peut préparer et appliquer un rename lorsque supporté ;
* les capacités absentes sont refusées proprement.

## Phase 7 — Durcissement

Livrables :

* security review ;
* remote development design ;
* logs redacted ;
* timeouts ;
* cancellation ;
* documentation utilisateur ;
* exemple d’installation locale.

Critères :

* CI entièrement verte ;
* procédure de démo reproductible ;
* aucun secret dans les logs ;
* aucun commit ni publication effectué.

---

# 29. Fonctionnalités explicitement hors MVP

Ne laisse pas ces fonctionnalités bloquer le MVP :

* debugger ;
* breakpoints ;
* evaluation runtime ;
* inline method ;
* move class ;
* safe delete ;
* change signature ;
* extraction de méthode ;
* édition symbolique générique ;
* collaboration multi-utilisateurs ;
* persistance durable des plans ;
* transport réseau public ;
* chiffrement applicatif au-dessus du transport local ;
* support complet navigateur ;
* support complet de tous les langages ;
* marketplace publication ;
* auto-update ;
* télémétrie.

Crée cependant une section roadmap.

---

# 30. Démonstration finale attendue

Prépare une procédure reproductible.

## Démo VS Code

1. démarrer le daemon ;
2. ouvrir la fixture TypeScript dans VS Code ;
3. démarrer l’extension en mode développement ;
4. vérifier l’enregistrement ;
5. lister les symboles ;
6. chercher les références ;
7. préparer un rename ;
8. afficher le plan ;
9. appliquer le plan ;
10. montrer les fichiers modifiés ;
11. modifier un document ;
12. montrer qu’un ancien plan retourne `STALE_DOCUMENT` ou `PRECONDITION_FAILED`.

## Démo JetBrains

Même scénario avec la fixture Java.

## Démo Serena

1. configurer le backend ;
2. sélectionner le workspace ;
3. appeler la recherche de symboles ;
4. appeler les références ;
5. exécuter un renommage lorsque possible ;
6. montrer le comportement lorsqu’une capacité est absente.

---

# 31. Définition de terminé

Le projet n’est terminé que lorsque :

* le protocole est documenté et validé ;
* le daemon est réellement exécutable ;
* l’extension VS Code se connecte réellement ;
* le plugin JetBrains se connecte réellement ;
* les deux adaptateurs exposent leurs capacités ;
* les workspaces sont routés correctement ;
* les documents possèdent des révisions ;
* les symboles possèdent handles et locators ;
* un rename VS Code fonctionne ;
* un rename JetBrains fonctionne ;
* un document obsolète est rejeté ;
* les plans expirent ;
* l’authentification locale fonctionne ;
* les logs ne contiennent pas les tokens ;
* les tests de conformité sont présents ;
* l’intégration Serena est implémentée ou fournie sous forme de patch applicable et testée ;
* la CI est verte ;
* la procédure de démo fonctionne ;
* aucune opération Git distante ou commit n’a été réalisée.

---

# 32. Méthode de travail attendue

Travaille par incréments cohérents.

À chaque phase :

1. rappelle brièvement l’objectif courant ;
2. inspecte les fichiers concernés ;
3. implémente ;
4. exécute les validations ;
5. corrige immédiatement les problèmes ;
6. mets à jour le plan et la documentation ;
7. passe à la phase suivante.

Ne produis pas uniquement des fichiers vides ou des TODO.

Lorsqu’une partie ne peut pas être entièrement réalisée :

* implémente la portion fonctionnelle maximale ;
* documente exactement la limite ;
* ajoute un test reproduisant le comportement actuel ;
* évite de simuler une réussite.

Ne supprime pas un test pour faire passer la CI.

Ne réduis pas la portée silencieusement.

---

# 33. Rapport final obligatoire

À la fin, fournis :

## Résumé

* architecture implémentée ;
* fonctionnalités opérationnelles ;
* fonctionnalités partielles ;
* fonctionnalités reportées.

## Fichiers principaux

Liste les fichiers importants créés ou modifiés.

## Validation

Liste toutes les commandes exécutées avec leur résultat réel.

## Démonstration

Donne les commandes exactes pour :

* installer ;
* lancer le daemon ;
* lancer VS Code ;
* lancer JetBrains ;
* lancer les tests ;
* utiliser l’intégration Serena.

## Risques restants

Liste les risques et limites sans les minimiser.

## Git

Confirme seulement :

* qu’aucun commit n’a été créé ;
* qu’aucun push n’a été effectué ;
* que les changements restent disponibles dans le working tree.

Commence maintenant par l’inspection du dépôt, la rédaction du plan et la création de la fondation du monorepo. Continue ensuite l’implémentation sans attendre une validation intermédiaire, sauf blocage externe réel.
s