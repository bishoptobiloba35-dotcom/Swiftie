export function haversineDistanceMeters(a:{latitude:number;longitude:number},b:{latitude:number;longitude:number}):number{
  const R=6371000;
  const toRad=(v:number)=>v*Math.PI/180;
  const dLat=toRad(b.latitude-a.latitude);
  const dLon=toRad(b.longitude-a.longitude);
  const x=Math.sin(dLat/2)**2+Math.cos(toRad(a.latitude))*Math.cos(toRad(b.latitude))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
export function etaMinutes(distanceMeters:number,speedKmh=30):number{
  if(!Number.isFinite(distanceMeters)||distanceMeters<0)return 0;
  return Math.max(1,Math.ceil(distanceMeters/(speedKmh*1000/60)));
}
