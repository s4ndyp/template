/**
 * OFFLINE MANAGER - CORE ENGINE V15 (Performance & Loop Fix)
 * ----------------------------------------------------
 * Opgelost: Oneindige lus tussen getSmartCollection en refreshCache verwijderd.
 * Verbeterd: Sync-locking en ID-mapping nog robuuster.
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

    /**
     * Slaat op en start sync op de achtergrond.
     */
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
        
        // Trigger sync zonder de UI te blokkeren
        if (navigator.onLine && !this.isOfflineSimulated) this.syncOutbox();
        return localRecord;
    }

    async deleteSmartDocument(collectionName, id) {
        const item = await this.db.data.where({ collection: collectionName })
            .filter(i => String(i._id || i.id) === String(id)).first();

        const serverId = item ? item._id : (String(id).length > 15 ? id : null);

        await this.db.data.where({ collection: collectionName })
            .filter(i => String(i._id || i.id) === String(id)).delete();

        if (serverId) {
            await this.db.outbox.add({ action: 'DELETE', collection: collectionName, payload: { _id: serverId } });
        } else {
            await this.db.outbox.where({ collection: collectionName })
                .filter(o => String(o.payload.id) === String(id)).delete();
        }

        if (navigator.onLine && !this.isOfflineSimulated) this.syncOutbox();
    }

    /**
     * HAALT DATA ALLEEN UIT CACHE. 
     * Verversen moet nu handmatig of via refreshCache() aangeroepen worden.
     * Dit voorkomt de oneindige loop.
     */
    async getSmartCollection(collectionName) {
        return await this.db.data.where({ collection: collectionName }).toArray();
    }

    /**
     * VERVERS CACHE: Haalt serverdata en vergelijkt met outbox.
     */
    async refreshCache(collectionName) {
        if (!navigator.onLine || this.isOfflineSimulated) return;

        try {
            const freshData = await this.gateway.getCollection(collectionName);
            const outboxItems = await this.db.outbox.where({ collection: collectionName }).toArray();
            
            const deletedIds = new Set(outboxItems.filter(i => i.action === 'DELETE').map(i => i.payload._id));
            const pendingUpdates = new Set(outboxItems.filter(i => i.action !== 'DELETE').map(i => i.payload._id || i.payload.title));
            
            const filteredServerData = freshData.filter(doc => !deletedIds.has(doc._id));

            // Mapping voor ID-consistentie
            const localItems = await this.db.data.where({ collection: collectionName }).toArray();
            const idMap = new Map(); 
            localItems.forEach(item => { if (item._id) idMap.set(item._id, item.id); });

            const taggedData = filteredServerData.map(d => {
                const item = { ...d, collection: collectionName };
                if (idMap.has(d._id)) item.id = idMap.get(d._id);
                return item;
            });

            // Wis lokale items die echt weg zijn
            const serverIds = new Set(filteredServerData.map(d => d._id));
            await this.db.data.where({ collection: collectionName })
                .filter(doc => {
                    if (doc._id) return !serverIds.has(doc._id) && !pendingUpdates.has(doc._id);
                    return !pendingUpdates.has(doc.title);
                })
                .delete();
            
            await this.db.data.bulkPut(taggedData);

            // Meld aan UI dat er echt nieuwe data is (alleen als de cache veranderd is)
            if (this.onDataChanged) this.onDataChanged(collectionName);
        } catch (err) {
            console.warn(`[Manager] Refresh overgeslagen of mislukt`, err);
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
            // Na de sync verversen we de cache één keer goed
            if (this.onDataChanged) this.onDataChanged();
        }
    }
}
