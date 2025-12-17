/**
 * UNIVERSAL WEB APP LOGIC (app.js)
 * Dit bestand bevat alle functionele logica voor de web app template.
 */

// 1. CONFIGURATIE
const APP_CONFIG = {
    appName: "Mijn Projecten",         // Bijv: "Test"
    appIcon: "fas fa-rocket", 
    collectionName: "items",           // Bijv: "projecten"
    collectionLabel: "Projecten",
    version: "2.6.0",
    defaultApiUrl: "http://10.10.2.20:5000" 
};

// 2. DATA GATEWAY CLASS
class DataGateway {
    constructor(baseUrl, clientId) {
        this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        this.clientId = clientId;
    }
    
    _getHeaders() { 
        return { 
            'Content-Type': 'application/json', 
            'x-client-id': this.clientId 
        }; 
    }

    async _handleResponse(res) {
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `API Fout: ${res.status}`);
        }
        return res.json();
    }

    async fetchAll(collection) {
        const res = await fetch(`${this.baseUrl}/api/${collection}`, { 
            headers: this._getHeaders() 
        });
        return this._handleResponse(res);
    }

    async create(collection, data) {
        const res = await fetch(`${this.baseUrl}/api/${collection}`, {
            method: 'POST', 
            headers: this._getHeaders(), 
            body: JSON.stringify(data)
        });
        return this._handleResponse(res);
    }

    async update(collection, id, data) {
        const res = await fetch(`${this.baseUrl}/api/${collection}/${id}`, {
            method: 'PUT', 
            headers: this._getHeaders(), 
            body: JSON.stringify(data)
        });
        return this._handleResponse(res);
    }

    async delete(collection, id) {
        const res = await fetch(`${this.baseUrl}/api/${collection}/${id}`, {
            method: 'DELETE', 
            headers: this._getHeaders()
        });
        return this._handleResponse(res);
    }
}

// 3. VUE APPLICATION INITIALISATIE
const { createApp, ref, onMounted, computed } = Vue;

createApp({
    setup() {
        // --- Reactive State ---
        const config = ref(APP_CONFIG);
        const isAuthenticated = ref(!!localStorage.getItem('universal_client_id'));
        const loginId = ref('');
        const loginError = ref('');
        const isLoading = ref(false);
        const activeTab = ref('dashboard');

        /**
         * DYNAMISCHE COLLECTIE NAAM
         * Combineert de app-naam en de gewenste collectie.
         * Voorbeeld: "Mijn Projecten" + "items" -> "mijn_projecten_items"
         */
        const fullCollectionName = computed(() => {
            const prefix = config.value.appName.toLowerCase().replace(/\s+/g, '_');
            const suffix = config.value.collectionName.toLowerCase().replace(/\s+/g, '_');
            return `${prefix}_${suffix}`;
        });
        
        const navigation = [
            { id: 'dashboard', label: 'Dashboard', icon: 'fas fa-chart-pie' },
            { id: 'overzicht', label: config.value.collectionLabel, icon: 'fas fa-layer-group' }
        ];

        const items = ref([]);
        const toasts = ref([]);
        const showModal = ref(false);
        const editingId = ref(null);
        const form = ref({ title: '', description: '' });

        let gateway = null;

        // --- API Helpers ---
        const getApiUrl = () => window.ENV_API_URL || config.value.defaultApiUrl;

        const initGateway = () => {
            const id = localStorage.getItem('universal_client_id');
            if(id) gateway = new DataGateway(getApiUrl(), id);
        };

        const showToast = (message, type = 'success') => {
            const id = Date.now();
            toasts.value.push({ id, message, type });
            setTimeout(() => toasts.value = toasts.value.filter(t => t.id !== id), 4000);
        };

        const refreshData = async () => {
            if(!gateway) return;
            isLoading.value = true;
            try {
                // Gebruik de berekende fullCollectionName
                items.value = await gateway.fetchAll(fullCollectionName.value);
            } catch (e) {
                showToast(e.message, 'error');
            } finally {
                isLoading.value = false;
            }
        };

        // --- Actions ---
        const login = () => {
            if(!loginId.value) return loginError.value = "ID is verplicht";
            localStorage.setItem('universal_client_id', loginId.value);
            isAuthenticated.value = true;
            initGateway();
            refreshData();
        };

        const logout = () => {
            localStorage.removeItem('universal_client_id');
            isAuthenticated.value = false;
            items.value = [];
        };

        const openModal = (item = null) => {
            if(item) {
                editingId.value = item._id;
                form.value = { ...item };
            } else {
                editingId.value = null;
                form.value = { title: '', description: '' };
            }
            showModal.value = true;
        };

        const closeModal = () => {
            showModal.value = false;
        };

        const saveItem = async () => {
            if(!form.value.title) return showToast("Titel is verplicht", "error");
            isLoading.value = true;
            try {
                if(editingId.value) {
                    await gateway.update(fullCollectionName.value, editingId.value, form.value);
                    showToast("Bijgewerkt!");
                } else {
                    await gateway.create(fullCollectionName.value, form.value);
                    showToast("Toegevoegd!");
                }
                closeModal();
                refreshData();
            } catch (e) {
                showToast(e.message, 'error');
            } finally {
                isLoading.value = false;
            }
        };

        const deleteItem = async (id) => {
            if(!confirm("Zeker weten?")) return;
            try {
                await gateway.delete(fullCollectionName.value, id);
                showToast("Verwijderd");
                refreshData();
            } catch (e) {
                showToast(e.message, 'error');
            }
        };

        // --- Lifecycle ---
        onMounted(() => {
            if(isAuthenticated.value) {
                initGateway();
                refreshData();
            }
        });

        return {
            config, navigation, isAuthenticated, loginId, loginError, isLoading,
            activeTab, items, toasts, showModal, form, editingId, fullCollectionName,
            login, logout, openModal, closeModal, saveItem, deleteItem
        };
    }
}).mount('#app');
