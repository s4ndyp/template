/**
 * OFFLINE MANAGER - CORE ENGINE V13 (Ghost Prevention)
 * ----------------------------------------------------
 * Deze versie voorkomt dat items die lokaal verwijderd zijn, weer 
 * verschijnen na een refresh zolang de server nog niet bijgewerkt is.
 */

class DataGateway {
    constructor(baseUrl, clientId, appName) {
        this.baseUrl = baseUrl;
        this.clientId = clientId;
        this.appName = appName;
    }

    _getUrl(collectionName, id = null) {
        let url = `${this.baseUrl}/api/${this.appName}_${collectionName}`;
        if (id) url += `/${id}`;
        return url;
    }

    async getCollection(name) {
        const response = await fetch(this._getUrl(name), {
            headers: { 'x-client-id': this.clientId }
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        return await response.json();
    }

    async saveDocument(name, data) {
        const method = data._id ? 'PUT' : 'POST';
        const url = this._getUrl(name, data._id);
        const response = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json', 'x-client-id': this.clientId },
            body: JSON.stringify(data)
        });
        if (!response.ok) throw new Error(`Save error: ${response.status}`);
        return await response.json();
    }

    async deleteDocument(name, id) {
        const response = await fetch(this._getUrl(name, id), {
            method: 'DELETE',
            headers: { 'x-client-id': this.clientId }
        });
        if (!response.ok) throw new Error(`Delete error: ${response.status}`);
        return await response.json();
    }
}

class OfflineManager {
    constructor(baseUrl, clientId, appName) {
        this.appName = appName;
        this.gateway = new DataGateway(baseUrl, clientId, appName);
        this.db = new Dexie(`OfflineEngine_${appName}_${clientId}`);
        this.db.version(1).stores({
            data: "++id, collection, _id",
            outbox: "++id, action, collection"
        });

        this.isSyncing = false;
        this.onSyncChange = null;
        this.onDataChanged = null;
        this.isOfflineSimulated = false;
    }

    async saveSmartDocument(collectionName, data) {
        let record = JSON.parse(JSON.stringify(data));

        if (record.id) {
            const latest = await this.db.data.get(Number(record.id));
            if (latest && latest._id) record._id = latest._id;
        }

        const localRecord = { ...record, collection: collectionName };
        if (record.id) {
            localRecord.id = Number(record.id);
        } else if (record._id) {
            const existing = await this.db.data.where({ collection: collectionName, _id: record._id }).first();
            if (existing) localRecord.id = existing.id;
        }

        const savedId = await this.db.data.put(localRecord);
        localRecord.id = savedId;

        const action = localRecord._id ? 'PUT' : 'POST';
        const pending = await this.db.outbox.where({ collection: collectionName })
            .filter(o => o.payload.id === savedId).first();
        
        if (pending) {
            await this.db.outbox.update(pending.id, { payload: localRecord });
        } else {
            await this.db.outbox.add({ action, collection: collectionName, payload: localRecord });
        }
        
        if (navigator.onLine && !this.isOfflineSimulated) this.syncOutbox();
        return localRecord;
    }

    async deleteSmartDocument(collectionName, id) {
        const item = await this.db.data.where({ collection: collectionName })
            .filter(i => String(i._id || i.id) === String(id)).first();

        const serverId = item ? item._id : (String(id).length > 15 ? id : null);

        // 1. Direct lokaal wissen
        await this.db.data.where({ collection: collectionName })
            .filter(i => String(i._id || i.id) === String(id)).delete();

        // 2. Outbox vullen
        if (serverId) {
            await this.db.outbox.add({ action: 'DELETE', collection: collectionName, payload: { _id: serverId } });
        } else {
            await this.db.outbox.where({ collection: collectionName })
                .filter(o => String(o.payload.id) === String(id)).delete();
        }

        if (navigator.onLine && !this.isOfflineSimulated) this.syncOutbox();
    }

    async getSmartCollection(collectionName) {
        const localData = await this.db.data.where({ collection: collectionName }).toArray();
        if (navigator.onLine && !this.isOfflineSimulated) this.refreshCache(collectionName);
        return localData;
    }

    /**
     * VERBETERDE CACHE REFRESH: Ghosting Prevention
     * We filteren server-data op basis van wat er nog in onze Outbox staat.
     */
    async refreshCache(collectionName) {
        try {
            const freshData = await this.gateway.getCollection(collectionName);
            const outboxItems = await this.db.outbox.where({ collection: collectionName }).toArray();
            
            // 1. Maak een lijst van IDs die we lokaal hebben verwijderd
            const deletedIds = new Set(outboxItems.filter(i => i.action === 'DELETE').map(i => i.payload._id));
            
            // 2. Maak een lijst van IDs/Titels die we momenteel lokaal aanpassen
            const pendingUpdates = new Set(outboxItems.filter(i => i.action !== 'DELETE').map(i => i.payload._id || i.payload.title));
            
            // 3. Filter de server data: gooi alles weg wat we gewist hebben
            const filteredServerData = freshData.filter(doc => !deletedIds.has(doc._id));

            // Stap A: Wis lokale items die NIET op de server staan en NIET in de outbox
            const serverIds = new Set(filteredServerData.map(d => d._id));
            await this.db.data.where({ collection: collectionName })
                .filter(doc => {
                    // Behou lokaal aangepaste items altijd
                    if (doc._id && pendingUpdates.has(doc._id)) return false;
                    if (!doc._id && pendingUpdates.has(doc.title)) return false;
                    
                    // Verwijder als het niet op de server staat
                    return doc._id && !serverIds.has(doc._id);
                })
                .delete();
            
            // Stap B: Zet de actuele server data in Dexie
            const taggedData = filteredServerData.map(d => ({ ...d, collection: collectionName }));
            await this.db.data.bulkPut(taggedData);

            if (this.onDataChanged) this.onDataChanged(collectionName);
        } catch (err) {
            console.warn(`[Manager] Refresh mislukt`, err);
        }
    }

    async syncOutbox() {
        if (!navigator.onLine || this.isOfflineSimulated || this.isSyncing) return;
        this.isSyncing = true;
        
        try {
            let items = await this.db.outbox.orderBy('id').toArray();
            if (this.onSyncChange) this.onSyncChange(items.length);

            while (items.length > 0 && !this.isOfflineSimulated) {
                const item = items[0];
                try {
                    if (item.action === 'DELETE') {
                        await this.gateway.deleteDocument(item.collection, item.payload._id);
                    } else {
                        const payload = { ...item.payload };
                        const dexieId = payload.id;
                        delete payload.id; delete payload.collection;

                        const response = await this.gateway.saveDocument(item.collection, payload);
                        if (item.action === 'POST' && response && response._id) {
                            await this.db.data.update(dexieId, { _id: response._id });
                        }
                    }
                    await this.db.outbox.delete(item.id);
                } catch (e) { break; }
                items = await this.db.outbox.orderBy('id').toArray();
                if (this.onSyncChange) this.onSyncChange(items.length);
            }
        } finally {
            this.isSyncing = false;
            if (this.onDataChanged) this.onDataChanged();
        }
    }
}
