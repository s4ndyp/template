# **Technical Specification: DataGateway & OfflineManager**

Dit document beschrijft de architectuur voor data-opslag en synchronisatie. Gebruik deze specificaties om nieuwe features of apps te coderen die naadloos aansluiten op de bestaande Python API en de lokale Dexie (IndexedDB) cache.

## **1\. De Lagen (Architecture Stack)**

1. **UI Layer**: Roept alleen OfflineManager aan. Gebruikt uitsluitend de \_id van MongoDB.  
2. **Logic Layer (OfflineManager)**: De "Slimme" tussenlaag. Vertaalt server-data naar lokale cache en beheert de ID-mapping.  
3. **Transport Layer (DataGateway)**: Handelt HTTP/JSON communicatie af.

## **2\. DataGateway (datagateway.js)**

De gateway communiceert direct met de Python MongoDB API.

* **Auth**: Elke aanroep bevat de header x-client-id.  
* **App-Prefix**: Collectienamen worden automatisch geprefixed (bijv. api/test\_tasks).

### **API Methodes:**

* getCollection(name): Haalt alle documenten uit een collectie.  
* saveDocument(name, data): Gebruikt POST voor nieuwe items (geen \_id) en PUT voor updates (wel \_id).
* deleteDocument(name).

## **3\. OfflineManager (offline\_manager.js)**

Beheert de lokale database (AppCache) via Dexie.js. Een volwassen manager ontzorgt de UI door ID-beheer over te nemen.

### **Slim ID-beheer (Architectuur):**

* **Local ID (id)**: Wordt alleen intern door Dexie gebruikt voor de database-index. Wordt **niet** gedeeld met de UI of de server.  
* **Server ID (\_id)**: De "Single Source of Truth". Alle acties in de app en op de server gebruiken dit ID.  
* **Auto-Upsert**: saveSmartDocument controleert altijd of een item met een bepaald \_id al bestaat. Zo ja, dan wordt het bestaande record bijgewerkt in plaats van dat er een nieuwe rij wordt toegevoegd.

## **4\. Initialisatie & Opstarten (Warm-up)**

De frontend configureert de manager en luistert naar verbindingsherstel.

const APP\_NAME \= 'jouw\_app\_naam';   
const CLIENT\_ID \= 'sandman';   
const API\_URL \= 'http://10.10.2.20:5000'; 

const manager \= new OfflineManager(API\_URL, CLIENT\_ID, APP\_NAME);

window.addEventListener('online', () \=\> {  
    manager.syncOutbox().then(() \=\> {  
        if (typeof renderApp \=== 'function') renderApp();  
    });  
});

## **5\. Multi-client Consistentie & Polling**

* **Actieve Sync**: Voer elke 60 seconden een refreshCache() uit.  
* **Focus Sync**: Ververs de cache wanneer de gebruiker de tab weer activeert (window.onfocus).

## **6\. Speciale Functionaliteiten (Bijlagen)**

* **Bijlagen**: Worden binair opgeslagen in Dexie en als **Base64** verzonden naar de API tijdens de sync.

## **7\. Optimistic UI: Identiteitsbewaking**

Om "spook-data" en duplicaten te voorkomen, moet de manager de identiteit van een document bewaken vanaf het moment van creatie.

### **De "Smart Manager" Flow:**

1. De UI stuurt data naar saveSmartDocument.  
2. De manager genereert een tijdelijke \_id als deze ontbreekt (of wacht op de server).  
3. De manager geeft het object **inclusief de (tijdelijke) ID** terug aan de UI.  
4. De UI slaat deze ID onmiddellijk op in zijn lokale state.

**Resultaat:** Een tweede klik op "Opslaan" wordt door de manager herkend als een update van hetzelfde item, waardoor er geen dubbele "POST" in de outbox komt.

## **8\. UI Rendering: De "Schone Lei" Methode**

Zelfs met een slimme manager kan de UI verward raken tijdens snelle acties. Gebruik daarom altijd de "Schoonmaken voor Tekenen" methode.

### **De Oplossing voor Visuele Dubbelingen:**

De render-functie mag nooit "slim" proberen te zijn door items toe te voegen aan een bestaande lijst. De UI moet altijd de lokale database als enige bron van waarheid beschouwen.

async function renderDashboard() {  
    const container \= document.getElementById('item-container');  
      
    // 1\. Forceer een lege container  
    container.innerHTML \= ''; 

    // 2\. Haal de 'Source of Truth' uit Dexie via de Manager  
    const items \= await manager.getSmartCollection('mijn\_collectie');

    // 3\. Teken alles opnieuw op basis van de verse database-staat  
    items.forEach(item \=\> {  
        container.appendChild(createCard(item));  
    });  
}

### **Waarom dit werkt:**

Door de container te legen, dwing je de UI om synchroon te lopen met de OfflineManager. Eventuele "dubbelgangers" die ontstaan in het geheugen van de browser worden hiermee direct weggepoetst.
