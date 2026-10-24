import {Sun} from 'lucide-react';
export default function Brand({light=false}: {light?:boolean}) {return <span className={'brand '+(light?'brand-light':'')}><Sun size={30} strokeWidth={1.6}/><span>helios<span className="brand-solar">SOLAR</span></span></span>}
