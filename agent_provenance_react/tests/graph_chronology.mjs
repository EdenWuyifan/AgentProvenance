import assert from 'node:assert/strict';
import { stageChronology, layoutChronologicalGroups } from '../app/components/graph_chronology.ts';
const family=(id,run,step)=>({id,instances:[{run,calls:[{step}]}]});
const graph={nodes:[family('start','a',1),family('left','a',3),family('right','a',4),family('join','a',7),family('unlinked','a',5)]};
const before=JSON.stringify(graph);
const groups=graph.nodes.map(node=>({id:node.id,memberIds:[node.id]}));
const times=stageChronology(graph,groups);
const boxes=groups.map(group=>({id:group.id,x:0,y:0,width:208,height:76}));
const links=[['start','left'],['start','right'],['left','join'],['right','join']].map(([source,target],i)=>({id:String(i),source,target,recordedSupport:2,priority:10}));
const workspace={positions:new Map(),pinned:new Set()};
const positions=layoutChronologicalGroups(boxes,links,times,workspace);
for(const link of links) assert(positions.get(link.source).x<positions.get(link.target).x,'Forward branches remain left to right');
assert(positions.get('unlinked').x>=positions.get('right').x,'An unlinked later call cannot be packed before earlier calls');
assert(positions.get('unlinked').x<=positions.get('join').x);
for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++){
 const a={...boxes[i],...positions.get(boxes[i].id)},b={...boxes[j],...positions.get(boxes[j].id)};
 assert(!(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y),'Cards cannot overlap');
}
assert.deepEqual(layoutChronologicalGroups([...boxes].reverse(),[...links].reverse(),times,workspace),positions,'Layout does not depend on input array ordering');
const repeated={nodes:[{id:'variant',instances:[{run:'short',calls:[{step:2},{step:4}]},{run:'long',calls:[{step:20},{step:40}]}]}]};
const timing=stageChronology(repeated,[{id:'merged',memberIds:['variant']}]).get('merged');
assert.equal(timing.order,11,'Each run contributes its actual first occurrence step, without moving early events just because a run is shorter');
assert.equal(timing.firstStep,2);assert.equal(timing.lastStep,40);
assert.equal(JSON.stringify(graph),before,'Chronological arrangement creates no causal/dependency edges or source edits');
assert.equal(links.length,4);
workspace.pinned.add('left');workspace.positions.set('left',{x:123,y:456});
assert.deepEqual(layoutChronologicalGroups(boxes,links,times,workspace).get('left'),{x:123,y:456});
console.log('Chronological display: ordered disconnected calls, multi-input branches, stable placement, source integrity and manual pins passed');
