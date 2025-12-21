/**
 * OFFLINE MANAGER - CORE ENGINE V12 (Performance Optimized)
 * --------------------------------------------------------
 * Toegevoegd: onDataChanged callback voor directe UI updates na sync.
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
        this.onDataChanged = null; // Callback voor de UI
    }

    /**
     * Slaat op en geeft onmiddellijk het resultaat terug voor de UI.
     */
    async saveSmartDocument(collectionName, data) {
        let record = JSON.parse(JSON.stringify(data));

        // Race-condition check
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
        
        // Start sync op de achtergrond, NIET awaiten!
        if (navigator.onLine) this.syncOutbox();
        
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

        if (navigator.onLine) this.syncOutbox();
    }

    async getSmartCollection(collectionName) {
        const localData = await this.db.data.where({ collection: collectionName }).toArray();
        if (navigator.onLine) this.refreshCache(collectionName);
        return localData;
    }

    /**
     * Verbeterde cache-refresh: Beschermt zowel items met server-ID's als splinternieuwe items.
     */
    async refreshCache(collectionName) {
        try {
            const freshData = await this.gateway.getCollection(collectionName);
            const outboxItems = await this.db.outbox.where({ collection: collectionName }).toArray();
            
            // Bescherm IDs en Titels die nog in de outbox staan
            const pendingIds = new Set(outboxItems.map(i => i.payload._id).filter(id => id));
            const pendingTitles = new Set(outboxItems.filter(i => !i.payload._id).map(i => i.payload.title));
            
            // Verwijder alleen data die NIET in de outbox staat
            await this.db.data.where({ collection: collectionName })
                .filter(doc => {
                    if (doc._id) return !pendingIds.has(doc._id);
                    return !pendingTitles.has(doc.title);
                })
                .delete();
            
            const taggedData = freshData.map(d => ({ ...d, collection: collectionName }));
            await this.db.data.bulkPut(taggedData);

            // Meld aan de UI dat er nieuwe data is
            if (this.onDataChanged) this.onDataChanged(collectionName);
        } catch (err) {
            console.warn(`[Manager] Cache refresh mislukt`, err);
        }
    }

    async syncOutbox() {
        if (!navigator.onLine || this.isSyncing) return;
        this.isSyncing = true;
        
        try {
            let items = await this.db.outbox.orderBy('id').toArray();
            let hasChanges = false;

            while (items.length > 0) {
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
                            hasChanges = true;
                        }
                    }
                    await this.db.outbox.delete(item.id);
                    hasChanges = true;
                } catch (e) { break; }
                items = await this.db.outbox.orderBy('id').toArray();
            }

            // Als er IDs zijn aangepast, laat de UI verversen
            if (hasChanges && this.onDataChanged) this.onDataChanged();
        } finally {
            this.isSyncing = false;
        }
    }
}
