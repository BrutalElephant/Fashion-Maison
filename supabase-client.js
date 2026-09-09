/* Safe static-deployment bridge. Inject window.FASHION_MAISON_CONFIG at deploy time; never include service keys. */
(function(){
  const c=window.FASHION_MAISON_CONFIG||{};
  const url=c.url||''; const key=c.publishableKey||''; let accessToken=sessionStorage.getItem('fm-access-token')||key;
  const headers=()=>({'apikey':key,'Authorization':`Bearer ${accessToken||key}`,'Content-Type':'application/json'});
  window.FashionMaisonSupabase={configured:Boolean(url&&key),url,key,
    setSession(t){accessToken=t||key},
    async rest(path,opts={}){if(!url||!key) return null; const r=await fetch(url+path,{...opts,headers:{...headers(),...(opts.headers||{})}}); if(!r.ok) throw new Error(`Supabase request failed (${r.status})`); return r.status===204?null:r.json()},
    async signIn(email,password){const r=await this.rest('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});accessToken=r.access_token||key;sessionStorage.setItem('fm-access-token',accessToken);window.dispatchEvent(new CustomEvent('fm-auth-change',{detail:r}));return r},
    async signUp(email,password,full_name){return this.rest('/auth/v1/signup',{method:'POST',body:JSON.stringify({email,password,data:{full_name}})})},
    async signOut(){accessToken=key;sessionStorage.removeItem('fm-access-token');return this.rest('/auth/v1/logout',{method:'POST'})},
    async getUser(){return this.rest('/auth/v1/user')},
    async getProfile(id){const rows=await this.rest(`/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);return rows?.[0]||null},
    async invoke(name,body){return this.rest(`/functions/v1/${name}`,{method:'POST',body:JSON.stringify(body)})},
    async homepageMerchandising(){return this.rest('/rest/v1/homepage_merchandising?select=*&enabled=eq.true&order=sort_order.asc')},
    async paymentSettings(){const r=await this.rest('/rest/v1/payment_settings?select=bank_name,account_name,account_number,payment_instructions&is_active=eq.true&limit=1');return r?.[0]||null},
    storagePublicUrl(path){if(!this.url||!path)return '';if(/^https?:\/\//i.test(path))return path;const clean=String(path).split('/').map(encodeURIComponent).join('/');return `${this.url}/storage/v1/object/public/product-images/${clean}`;},
    storageOptimizedUrl(path){if(!this.url||!path)return '';if(/^https?:\/\//i.test(path))return path;const clean=String(path).split('/').map(encodeURIComponent).join('/');return `${this.url}/storage/v1/render/image/public/product-images/${clean}?width=900&quality=78&resize=contain`;}, 
    async uploadPaymentReceipt(path,file){if(!this.url||!this.key)throw new Error('Supabase is not configured');const r=await fetch(`${this.url}/storage/v1/object/payment-receipts/${path}`,{method:'POST',headers:{...headers(),'Content-Type':file.type,'x-upsert':'false'},body:file});if(!r.ok)throw new Error('Receipt upload failed');return r.json()},
    async submitManualPayment(payload){return this.invoke('submit-manual-payment',payload)},
    async verifyManualPayment(payload){return this.invoke('verify-manual-payment',payload)}, 
    async saveMerchandising(record){return this.invoke('admin-catalog',{table:'homepage_merchandising',operation:'upsert',record})},
    onAuthChange(callback){window.addEventListener('fm-auth-change',e=>callback(e.detail));return()=>window.removeEventListener('fm-auth-change',callback)}
  };
})();
