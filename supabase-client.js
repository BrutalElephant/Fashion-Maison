/* Safe static-deployment bridge. Inject window.FASHION_MAISON_CONFIG at deploy time; never include service keys. */
(function(){
  const c=window.FASHION_MAISON_CONFIG||{};
  const url=c.url||''; const key=c.publishableKey||''; let accessToken=sessionStorage.getItem('fm-access-token')||key;
  const headers=()=>({'apikey':key,'Authorization':`Bearer ${accessToken||key}`,'Content-Type':'application/json'});

  function encodeObjectPath(path){
    let p=String(path||'').replace(/^\/+|\/+$/g,'');
    if(p&&p.indexOf('/')===-1&&/%2f/i.test(p)){
      try{p=decodeURIComponent(p)}catch(e){}
    }
    return p.split('/').map(seg=>{
      let decoded=seg;
      try{decoded=decodeURIComponent(seg)}catch(e){decoded=seg}
      return encodeURIComponent(decoded);
    }).join('/');
  }

  // Build a publicly fetchable URL for a product image stored in the product-images bucket.
  // Accepts: absolute URLs, bucket-prefixed paths, object/render URLs, and raw storage_path values
  // (including spaces / unicode). Does not use Image Transformations — those are not required
  // and were encoding slashes, which made nested keys such as products/<id>/file.jpg 404.
  function storagePublicUrl(path){
    if(!url||path==null||path==='')return '';
    let raw=String(path).trim();
    if(!raw)return '';
    if(/^https?:\/\//i.test(raw)){
      const stored=raw.match(/^https?:\/\/[^/?#]+\/storage\/v1\/(?:render\/image|object)\/public\/([^/?#]+)\/([^?#]+)/i);
      if(stored){
        const bucket=(()=>{try{return decodeURIComponent(stored[1])}catch(e){return stored[1]}})();
        let objectPath=stored[2];
        try{objectPath=decodeURIComponent(objectPath)}catch(e){}
        return `${url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeObjectPath(objectPath)}`;
      }
      return raw;
    }
    raw=raw.replace(/^\/+/, '');
    raw=raw.replace(/^storage\/v1\/(?:object|render\/image)\/public\//,'');
    let bucket='product-images';
    const known=/^(product-images|product_images)\//i;
    if(known.test(raw)){
      const slash=raw.indexOf('/');
      bucket=raw.slice(0,slash)==='product_images'?'product-images':raw.slice(0,slash);
      raw=raw.slice(slash+1);
    }
    if(raw.startsWith('public/')) raw=raw.slice(7);
    if(!raw)return '';
    return `${url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeObjectPath(raw)}`;
  }

  window.FashionMaisonSupabase={configured:Boolean(url&&key),url,key,
    setSession(t){accessToken=t||key},
    async rest(path,opts={}){if(!url||!key) return null; const r=await fetch(url+path,{...opts,headers:{...headers(),...(opts.headers||{})}}); if(!r.ok){let msg=`Supabase request failed (${r.status})`;try{const j=await r.json();msg=j.message||j.code||msg;const err=new Error(msg);err.payload=j;throw err}catch(e){if(e&&e.payload)throw e;throw new Error(msg)}} return r.status===204?null:r.json()},
    async signIn(email,password){const r=await this.rest('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});accessToken=r.access_token||key;sessionStorage.setItem('fm-access-token',accessToken);window.dispatchEvent(new CustomEvent('fm-auth-change',{detail:r}));return r},
    async signUp(email,password,full_name){return this.rest('/auth/v1/signup',{method:'POST',body:JSON.stringify({email,password,data:{full_name}})})},
    async signOut(){accessToken=key;sessionStorage.removeItem('fm-access-token');return this.rest('/auth/v1/logout',{method:'POST'})},
    async getUser(){return this.rest('/auth/v1/user')},
    async getProfile(id){const rows=await this.rest(`/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);return rows?.[0]||null},
    async invoke(name,body){return this.rest(`/functions/v1/${name}`,{method:'POST',body:JSON.stringify(body)})},
    async homepageMerchandising(){return this.rest('/rest/v1/homepage_merchandising?select=*&enabled=eq.true&order=sort_order.asc')},
    async paymentSettings(){
      if(!url||!key)return null;
      const map=row=>({
        bank_name:row.bank_name||'',
        account_name:row.account_name||'',
        account_number:row.account_number||'',
        payment_instructions:row.payment_instructions||row.manual_instructions||'',
        paystack_enabled:row.paystack_enabled!==false,
        manual_transfer_enabled:row.manual_transfer_enabled!==false,
        currency:row.currency||'NGN'
      });
      try{
        const r=await this.rest('/rest/v1/payment_settings?select=bank_name,account_name,account_number,manual_instructions,payment_instructions,paystack_enabled,manual_transfer_enabled,currency&store_id=is.null&limit=1');
        const row=Array.isArray(r)?r[0]:null;
        return row?map(row):null;
      }catch(e){
        try{
          const r=await this.rest('/rest/v1/payment_settings?select=bank_name,account_name,account_number,manual_instructions,paystack_enabled,manual_transfer_enabled&store_id=is.null&limit=1');
          const row=Array.isArray(r)?r[0]:null;
          return row?map(row):null;
        }catch(err){return null}
      }
    },
    storagePublicUrl,
    productImageUrl:storagePublicUrl,
    async uploadProductImage(path,file){
      if(!url||!key)throw new Error('Supabase is not configured');
      const objectPath=encodeObjectPath(String(path||'').replace(/^\/+/,''));
      const r=await fetch(`${url}/storage/v1/object/product-images/${objectPath}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${accessToken||key}`,'Content-Type':file.type||'application/octet-stream','x-upsert':'true'},body:file});
      if(!r.ok){let msg='Image upload failed';try{const j=await r.json();msg=j.message||j.error||msg}catch(e){}throw new Error(msg)}
      try{return await r.json()}catch(e){return {path}}
    },
    async uploadPaymentReceipt(path,file){
      if(!url||!key)throw new Error('Supabase is not configured');
      const objectPath=encodeObjectPath(String(path||'').replace(/^\/+/,''));
      const r=await fetch(`${url}/storage/v1/object/payment-receipts/${objectPath}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${accessToken||key}`,'Content-Type':file.type||'application/octet-stream','x-upsert':'false'},body:file});
      if(!r.ok){let msg='Receipt upload failed';try{const j=await r.json();msg=j.message||j.error||msg}catch(e){}throw new Error(msg)}
      try{return await r.json()}catch(e){return {path}}
    },
    async submitManualPayment(payload){return this.invoke('submit-manual-payment',payload)},
    async verifyManualPayment(payload){return this.invoke('verify-manual-payment',payload)},
    async saveMerchandising(record){return this.invoke('admin-catalog',{table:'homepage_merchandising',operation:'upsert',record})},
    onAuthChange(callback){window.addEventListener('fm-auth-change',e=>callback(e.detail));return()=>window.removeEventListener('fm-auth-change',callback)}
  };
})();
