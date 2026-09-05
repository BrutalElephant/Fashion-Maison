/* Fashion Maison Cinematic Display Engine: lightweight, scroll-driven, reduced-motion aware. */
(function(){
 const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
 function reveal(el){el.classList.add('fm-visible');el.dispatchEvent(new CustomEvent('fm:scene-enter',{bubbles:true}))}
 function exit(el){el.dispatchEvent(new CustomEvent('fm:scene-exit',{bubbles:true}))}
 function init(){const hero=document.querySelector('.heroimg');if(hero&&!hero.dataset.rotating){const frames=['assets/afropop-hero.png','assets/afropop-watch.png','assets/street-sunglasses.png','assets/native-leather.png'];let i=0;hero.dataset.rotating='true';
 // Only rotate over frames that actually exist; never blank the hero with 404s.
 const probe=new Image();probe.onload=()=>{if(!reduce)setInterval(()=>{i=(i+1)%frames.length;hero.classList.add('fm-frame-out');setTimeout(()=>{hero.style.backgroundImage=`url('${frames[i]}')`;hero.classList.remove('fm-frame-out')},420)},5200)};probe.src=frames[0]}const nodes=document.querySelectorAll('.reveal,.story-feature,.signature,.category-tile,.brand-moment');if(reduce){nodes.forEach(reveal);return}const io=new IntersectionObserver((entries)=>entries.forEach(e=>{if(e.isIntersecting){reveal(e.target);io.unobserve(e.target)}}),{threshold:.14,rootMargin:'0px 0px -8%'});nodes.forEach(n=>io.observe(n));
  let ticking=false; const parallax=()=>{ticking=false;if(reduce)return;document.querySelectorAll('.story-image,.signature-image').forEach(el=>{const r=el.getBoundingClientRect(),d=(r.top-innerHeight/2)*-.025;el.style.setProperty('--fm-drift',`${d}px`)})};addEventListener('scroll',()=>{if(!ticking){ticking=true;requestAnimationFrame(parallax)}},{passive:true});parallax()}
 window.FashionMaisonMotion={init,sceneEnter:reveal,sceneExit:exit}; addEventListener('DOMContentLoaded',init); addEventListener('hashchange',()=>setTimeout(init,0));
})();
