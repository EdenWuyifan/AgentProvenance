import type { Box, Point } from './graph_layout';
type PortBox=Box&{circle?:boolean};
export function connectionPorts(boxes:PortBox[],links:Array<{id:string;source:string;target:string}>){
  const nodes=new Map(boxes.map(box=>[box.id,box]));
  const result=new Map<string,{source:Point;target:Point;sourceDelta:Point;targetDelta:Point}>();
  for(const link of links){
    const port=(id:string,outgoing:boolean)=>{
      const box=nodes.get(id)!;
      const peers=links.filter(edge=>(outgoing?edge.source:edge.target)===id).sort((a,b)=>{
        const left=nodes.get(outgoing?a.target:a.source)!,right=nodes.get(outgoing?b.target:b.source)!;
        return left.y+left.height/2-right.y-right.height/2||left.x-right.x||a.id.localeCompare(b.id);
      });
      const spread=Math.min((box.height-(box.circle?6:24))/2,(peers.length-1)*7);
      const dy=peers.length>1?-spread+peers.findIndex(edge=>edge.id===link.id)*2*spread/(peers.length-1):0;
      const radius=box.width/2,dx=box.circle?Math.sqrt(radius*radius-dy*dy):radius;
      const x=box.x+radius+(outgoing?dx:-dx),y=box.y+box.height/2+dy;
      return {point:{x,y},delta:{x:x-(outgoing?box.x+box.width:box.x),y:dy}};
    };
    const source=port(link.source,true),target=port(link.target,false);
    result.set(link.id,{source:source.point,target:target.point,sourceDelta:source.delta,targetDelta:target.delta});
  }
  return result;
}
