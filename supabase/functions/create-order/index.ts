import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const headers={"Access-Control-Allow-Origin":"*","Content-Type":"application/json"};
const out=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
Deno.serve(async req=>{if(req.method==='OPTIONS')return new Response('ok',{headers});try{
 const auth=req.headers.get('Authorization'); if(!auth)return out({code:'UNAUTHORIZED'},401);
 const url=Deno.env.get('SUPABASE_URL')!, anon=Deno.env.get('SUPABASE_ANON_KEY')!, service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
 const userDb=createClient(url,anon,{global:{headers:{Authorization:auth}}}); const {data:{user}}=await userDb.auth.getUser(); if(!user)return out({code:'UNAUTHORIZED'},401);
 const body=await req.json(); const {items,address_id,delivery_method,idempotency_key}=body;
 if(!Array.isArray(items)||!items.length||!idempotency_key)return out({code:'INVALID_QUANTITY',message:'Cart items and idempotency key are required.'},400);
 if(items.some((x:any)=>!Number.isInteger(x.quantity)||x.quantity<1||x.quantity>99))return out({code:'INVALID_QUANTITY',message:'Every quantity must be a whole number between 1 and 99.'},400);
 const db=createClient(url,service); // trusted transaction is encapsulated in the SQL RPC
 const {data,error}=await db.rpc('create_order_atomically',{p_customer_id:user.id,p_items:items,p_address_id:address_id||null,p_delivery_method:delivery_method||'store_pickup',p_idempotency_key:idempotency_key});
 if(error){console.error('create-order failed',error.message);return out({code:error.message.includes('PRICE_CHANGED')?'PRICE_CHANGED':error.message.includes('STOCK_CHANGED')?'STOCK_CHANGED':'ORDER_FAILED',message:error.message},409)}
 console.log('order created',data?.order_number);return out(data);
}catch(e){console.error('create-order error',e);return out({code:'ORDER_FAILED',message:'Unable to create order.'},500)}});
