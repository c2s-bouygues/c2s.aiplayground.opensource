# Plugin Atlassian — intégration du serveur MCP officiel

Ce plugin expose dans AI Playground les outils du **serveur MCP officiel Atlassian**
(Jira, Confluence, Jira Service Management, Bitbucket, Compass, Loom, Teamwork Graph).
Il ne réimplémente aucune API : il découvre dynamiquement les outils publiés par
`https://mcp.atlassian.com/v2/mcp` et les relaie, chaque appel étant exécuté avec
l'identité de l'utilisateur connecté (OAuth 2.1) ou avec un jeton d'API partagé.

Sources : [atlassian/atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server),
[Configure OAuth 2.1](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/configuring-oauth-2-1/),
[Domaines supportés](https://support.atlassian.com/security-and-access-policies/docs/available-atlassian-rovo-mcp-server-domains/),
[Fix OAuth consent block](https://support.atlassian.com/rovo/kb/fix-oauth-consent-block-for-atlassian-rovo-mcp-server-in-atlassian-cloud/).

---

## 1. Prérequis côté Atlassian

Le site cible doit être **Atlassian Cloud** (domaine `*.atlassian.net`). Le serveur MCP
officiel ne fonctionne pas avec Jira/Confluence Data Center (on-prem).

### 1.1 Activation du serveur MCP (rôle Org admin)

Dans `https://admin.atlassian.com/` → organisation → **Rovo** → **Rovo MCP server** :

| Réglage | Action |
|---|---|
| Serveur MCP | Activer, choisir les utilisateurs/groupes autorisés |
| **Domain settings** | Ajouter la redirect URL de **chaque** déploiement (voir §1.2) |
| Authentication → API token | Activer uniquement si le mode `api_token` est utilisé (obligatoire pour JSM) |

### 1.2 Liste blanche des redirect URL (indispensable)

Atlassian vérifie le domaine de redirection **après** le clic sur *Accepter* de l'écran de
consentement. Un domaine absent de la liste produit l'erreur générique :

```
https://id.atlassian.com/error?error=invalid_request&error_description=Incorrect request parameters
```

Par défaut Atlassian n'autorise que `http://localhost` / `http://127.0.0.1` et une liste fixe
d'éditeurs (Claude.ai, ChatGPT, Cursor…). **Tout domaine d'entreprise doit être ajouté**, avec
protocole explicite. Le chemin de callback est imposé par l'hôte :

```
{origine}/api/plugins/atlassian/oauth/callback
```

Entrées à ajouter dans *Domain settings* → *Add domain* (motif `/**` accepté), une par
origine publique du playground, par exemple :

```
https://playground.example.com/**
https://beta.playground.example.com/**
```

Le dev local en `https://localhost:5173` n'est **pas** couvert par la règle localhost
(HTTP seulement) : soit l'ajouter aussi (`https://localhost:5173/**`), soit servir en HTTP.

Si l'erreur persiste après ajout : supprimer l'entrée, la ré-ajouter à l'identique,
enregistrer, réessayer en navigation privée (le réglage peut être affiché sans être
propagé au service d'enforcement — cf. KB Atlassian).

> **Problème connu (septembre 2026).** Sur certaines organisations, la liste « Vos domaines »
> n'est pas appliquée par le serveur d'autorisation : le consentement affiche
> *« Access to this domain is restricted. Your admin has blocked this domain … »* pour un domaine
> pourtant listé sous toutes les formes documentées, alors que les domaines pris en charge par
> Atlassian (`localhost`, `claude.ai`…) passent. Le problème est indépendant du client OAuth, de la
> ressource (`v2/mcp` ou `v1/mcp/authv2`) et du format du motif.
> Suivi : [atlassian/atlassian-mcp-server#254](https://github.com/atlassian/atlassian-mcp-server/issues/254).
> Contournement en attendant : développer/valider en `http://localhost:*/**`, ou activer
> l'*Enterprise-managed authentication* (§1.3) si l'IdP le permet.

### 1.3 Enterprise-managed authentication (beta)

Onglet *Authentification* → « Allow enterprise managed authentication ». L'autorisation MCP passe
alors par l'IdP de l'organisation (Cross App Access / XAA : assertion d'identité échangée au token
endpoint Atlassian) et **la liste de domaines ne s'applique plus**. Prérequis : un IdP compatible
(documenté par Atlassian pour Okta uniquement) et un mode d'authentification dédié dans le plugin,
non implémenté à ce jour.

### 1.4 Ce qu'il ne faut PAS faire

- **Ne pas créer d'app OAuth 2.0 (3LO) dans `developer.atlassian.com`.** Le serveur MCP a son
  propre serveur d'autorisation et n'accepte pas ces `client_id`. Le plugin enregistre son
  client automatiquement (Dynamic Client Registration).
- Ne pas utiliser les anciens endpoints `https://mcp.atlassian.com/v1/authorize|token|register` :
  leurs jetons sont refusés par la ressource v2 (`401 invalid_token`).

---

## 2. Configuration du plugin (écran admin)

| Champ | Valeur recommandée | Notes |
|---|---|---|
| MCP Server URL | *(vide)* → `https://mcp.atlassian.com/v2/mcp` | |
| Expose all tools | activé | Ajoute `?tools=all` : liste plate de tous les outils au lieu des méta-outils discover/execute |
| Authentication mode | `oauth` | `api_token` pour un usage headless / JSM |
| OAuth Client ID | vide au 1er lancement, puis coller le `client_id` logué | Voir §3 |
| OAuth Client Secret | vide | Client public PKCE |
| OAuth Scopes | *(défaut)* | `offline_access read:me` + agent-interface Jira/Confluence/Rovo |
| OAuth Authorize URL | *(vide)* → `https://auth.atlassian.com/authorize` | |
| OAuth Token URL | *(vide)* → `https://auth.atlassian.com/oauth/token` | |
| OAuth Registration URL | *(vide)* → `https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register` | Serveur d'autorisation annoncé par la ressource v2 |
| API token e-mail / key | vide en mode `oauth` | Repli env `ATLASSIAN_API_TOKEN_EMAIL` / `ATLASSIAN_API_TOKEN` |
| Default cloudId / site URL | `cloudId` du site | Récupérer sur `https://<site>.atlassian.net/_edge/tenant_info` |
| Timeout | 60 s | |

Les endpoints OAuth par défaut proviennent de
`https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp` →
`authorization_servers` → `.well-known/oauth-authorization-server`. Ne les surcharger que si
Atlassian change de serveur d'autorisation.

### Scopes disponibles

Liste complète dans les métadonnées de la ressource. Les principaux :

| Produit | Scopes |
|---|---|
| Jira | `read/write/search/delete/manage:jira:agent-interface` |
| Confluence | `read/write/search:confluence:agent-interface` |
| Rovo search | `search:rovo:agent-interface` |
| Bitbucket | `read/write:bitbucket:agent-interface`, `search:code:agent-interface` |
| Compass / Goals / Projects / Teams / Loom | `read/write:<produit>:agent-interface` |
| Teamwork Graph | `read:all:twg`, `write:all:twg` |

Les scopes n'élèvent jamais les droits : l'utilisateur n'accède qu'à ce qu'il voit déjà
dans Jira/Confluence.

---

## 3. Mise en service

1. Déployer avec le plugin activé. Vérifier que l'origine publique HTTPS est bien celle
   ajoutée dans *Domain settings*.
2. Un **admin** ouvre le sélecteur d'outils → catégorie Atlassian → **Connecter**.
   Le flux passe par `id.atlassian.com` puis l'écran de consentement Rovo
   (nom de l'app, domaine de redirection, sélection du site, permissions Read/Write/Search).
3. Au premier *Connecter*, le plugin enregistre un client OAuth et logue :
   ```
   [atlassian] Registered OAuth client dynamically (client_id=XXXX). Persist it in the plugin config ("oauthClientId")
   ```
   Coller ce `client_id` dans **OAuth Client ID**. Sans cela, le client vit en mémoire :
   après un redémarrage les refresh tokens échouent et les utilisateurs doivent se reconnecter.
   Le client est lié à la redirect URI → **un `client_id` distinct par environnement**
   (prod, beta, dev).
4. L'admin lance **Refresh tools** (`/api/admin/plugins/atlassian/refresh`). Les outils
   découverts sont enregistrés et rehydratés au redémarrage (`skipRefreshOnRestart`).
5. Chaque utilisateur se connecte à son tour ; ses appels utilisent son propre jeton.

---

## 4. Mode `api_token` (headless)

Requis pour les outils **Jira Service Management** et pour les usages sans utilisateur.

- L'org admin active *API token* dans Rovo MCP server → Authentication.
- Jeton personnel : créer sur `https://id.atlassian.com/manage-profile/security/api-tokens`,
  renseigner **API token e-mail** + **API token** (Basic).
- Compte de service : renseigner uniquement la clé (Bearer), e-mail vide.
- Tous les appels s'exécutent avec cette identité unique.

---

## 5. Dépannage

| Symptôme | Cause | Correctif |
|---|---|---|
| `Atlassian non connecté` | Aucun jeton pour l'utilisateur/admin | Cliquer *Connecter* |
| `401 … invalid_token` | Jeton émis par l'ancien serveur `mcp.atlassian.com/v1/*`, ou jeton sans `resource` | Vider les URL OAuth surchargées et *OAuth Client ID*, déconnecter/reconnecter |
| Consentement OK puis `invalid_request / Incorrect request parameters` | Redirect URL absente de *Domain settings* (ou `https://localhost`) | §1.2 |
| « Your organization admin must authorize access from this redirect URL » | Idem, variante affichée sur le consentement | §1.2 |
| « Access to this domain is restricted / Your admin has blocked this domain » alors que le domaine est listé | Liste « Vos domaines » non appliquée côté Atlassian | Problème connu, voir §1.2 et [issue #254](https://github.com/atlassian/atlassian-mcp-server/issues/254) |
| Aucun site proposé sur le consentement | MCP non activé pour l'org ou pas de licence Jira/Confluence | §1.1 |
| Refresh échoue après redémarrage | Client DCR perdu (mémoire) | Renseigner *OAuth Client ID* (§3) |
| `429` | Quota Atlassian | Le message indique `retry-after` |
| Outils JSM en erreur en mode oauth | JSM exige `api_token` | §4 |

Le message 401 du plugin inclut l'en-tête `WWW-Authenticate` et le corps renvoyé par
Atlassian pour faciliter le diagnostic.

---

## 6. Architecture

```
plugins/atlassian/
├── manifest.json        métadonnées, configSchema, skipRefreshOnRestart
├── index.ts             discoverTools / rehydrateTools / discoverPrompts / validateConfig
├── lib/
│   ├── config.ts        URLs par défaut, scopes, resource (RFC 8707), en-tête API token
│   ├── oauth.ts         DCR, PKCE S256, authorize/exchange/refresh, identité (read:me)
│   ├── mcp-client.ts    client Streamable HTTP JSON-RPC (initialize, session, SSE/JSON, 401/404/429)
│   └── shared.ts        résolution du jeton (admin vs utilisateur), wrapper runTool
└── tools/proxy.ts       fabrique d'outils proxy, catégorisation par produit, injection cloudId
```

Flux OAuth : PRM `v2/mcp` → serveur d'autorisation `auth.atlassian.com/<tenant>` → DCR
(`token_endpoint_auth_method: none`) → `/authorize` avec `resource=https://mcp.atlassian.com/v2/mcp`
+ PKCE → consentement (choix du site) → `/oauth/token` avec `resource` → `initialize` MCP →
`tools/list` (paginé) → outils exposés.
