# **Technische Specificatie: De Offline-First Architectuur**

Dit document beschrijft hoe de UI, de OfflineManager en de DataGateway samenwerken. Het is cruciaal dat elke nieuwe app of feature zich strikt aan deze hiërarchie houdt om data-corruptie en synchronisatiefouten te voorkomen.

## **1\. De Gouden Regel van Communicatie**

De hiërarchie is een eenrichtingsweg voor de UI:  
UI (App Logic) ➔ OfflineManager ➔ DataGateway ➔ Server (API)

* **De UI** spreekt **alleen** met de OfflineManager.  
* **De UI** mag **nooit** direct functies van de DataGateway aanroepen.  
* **De UI** gaat ervan uit dat elke actie (opslaan/verwijderen) onmiddellijk lukt (Optimistic UI).

## **2\. Technische Details: Headers & Auth**

Onder de motorkap handelt de DataGateway alle server-specifieke eisen af. De UI-laag hoeft hier geen rekening mee te houden:

* **x-client-id**: Elke aanroep naar de server bevat automatisch deze header. Dit wordt geconfigureerd bij het initialiseren van de Gateway.  
* **Content-Type**: De gateway zorgt voor de juiste JSON-transformatie en headers.  
* **URL-Prefixing**: Collectienamen worden door de gateway automatisch vertaald naar de juiste API-endpoints.

## **3\. De "Smart" Methode Set**

De OfflineManager bevat "Smart"-functies. Ze doen drie dingen tegelijk: de lokale database bijwerken, de Outbox vullen, en de synchronisatie starten.

### **A. getSmartCollection(collectionName)**

Haalt data direct uit de lokale **Dexie cache** (Source of Truth) en ververst op de achtergrond de cache via de server.

### **B. saveSmartDocument(collectionName, data)**

Slaat data direct op in Dexie (met tijdelijk ID indien nodig), voegt een actie toe aan de Outbox en triggert de synchronisatie.

### **C. deleteSmartDocument(collectionName, id)**

Verwijdert het item onmiddellijk uit de lokale Dexie cache en zet een DELETE opdracht in de Outbox.

## **4\. Initialisatie & Opstarten (Warm-up)**

De frontend configureert de manager en luistert naar verbindingsherstel om achterstallige wijzigingen direct te verwerken.

const APP\_NAME \= 'appnaam';  
const CLIENT\_ID \= 'sandman';  
const API\_URL \= 'http://10.10.2.20:5000';

const manager \= new OfflineManager(API\_URL, CLIENT\_ID, APP\_NAME);

window.addEventListener('online', () \=\> {  
    manager.syncOutbox().then(() \=\> {  
        if (typeof renderApp \=== 'function') renderApp();  
    });  
});

## **5\. Multi-client Consistentie & Polling**

Om data op meerdere apparaten synchroon te houden, gebruikt de app twee strategieën:

* **Actieve Sync**: Voer elke 60 seconden een refreshCache() uit op de achtergrond.  
* **Focus Sync**: Ververs de cache wanneer de gebruiker de tab weer activeert (window.onfocus).

## **6\. De Outbox & Sync Logica**

Wanneer de manager merkt dat er internet is (navigator.onLine), loopt hij de Outbox af:

1. **Actie check**: Is het een POST, PUT of DELETE?  
2. **Gateway aanroep**: De opdracht wordt doorgegeven aan de DataGateway (inclusief headers).  
3. **Bevestiging**: Pas bij een "OK" van de server wordt het item uit de Outbox verwijderd.  
4. **ID Koppeling**: Bij een POST vervangt de manager het tijdelijke lokale ID door het echte server-ID (\_id) in de cache.

## **7\. Optimistic UI: Identiteitsbewaking**

Om "spook-data" en duplicaten te voorkomen, bewaakt de manager de identiteit van een document vanaf creatie.

### **De Smart Manager Flow:**

1. De UI stuurt data naar saveSmartDocument.  
2. De manager genereert een tijdelijke \_id als deze ontbreekt.  
3. De manager geeft het object **inclusief de (tijdelijke) ID** direct terug aan de UI.  
4. De UI slaat deze ID onmiddellijk op in zijn lokale state.

**Resultaat:** Een tweede klik op "Opslaan" wordt herkend als een update van hetzelfde item, waardoor dubbele "POST" acties in de outbox worden voorkomen.

## **8\. UI Rendering: De "Schone Lei" Methode**

De UI moet altijd de lokale database als enige bron van waarheid beschouwen. Gebruik de "Schoonmaken voor Tekenen" methode om visuele dubbelingen te voorkomen.

async function renderDashboard() {  
    const container \= document.getElementById('item-container');  
      
    // 1\. Forceer een lege container  
    container.innerHTML \= ''; 

    // 2\. Haal de 'Source of Truth' uit Dexie via de Manager  
    const items \= await manager.getSmartCollection('mijn\_collectie');

    // 3\. Teken alles opnieuw  
    items.forEach(item \=\> {  
        container.appendChild(createCard(item));  
    });  
}

## **9\. Implementatie Checklist voor de UI**

* Gebruik **nooit** fetch() of gateway direct in de UI componenten.  
* Roep renderContent() of renderDashboard() altijd aan **na** een await op een Smart-functie.  
* Zorg dat je bij het renderen van lijsten altijd eerst de container leegt.