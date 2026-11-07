from pathlib import Path
import json, html
from collections import defaultdict
ROOT = Path(__file__).resolve().parents[1] / 'site' / 'assets'
p=26
cols={c:260+i*p for i,c in enumerate('ABCDE')}
cols.update({c:442+i*p for i,c in enumerate('FGHIJ')})
def pos(h): return cols[h[0]],180+(int(h[1:])-1)*p
def text(x,y,s,cls='label',extra=''):
 return f'<text x="{x}" y="{y}" class="{cls}" {extra}>{html.escape(str(s))}</text>'
def circle(x,y,r,fill,stroke='none',sw=1):return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'
def line(x1,y1,x2,y2,stroke,width=2,extra=''):return f'<path d="M{x1} {y1} L{x2} {y2}" fill="none" stroke="{stroke}" stroke-width="{width}" {extra}/>'
colors={'3V3':'#ef615d','GND':'#4d5968','CLK':'#e3b639','DAT':'#24bed0','PTT':'#9c7be8'}
left=['P0.06 / D1','P0.08 / D0','GND','GND','P0.17 / D2','P0.20 / D3','P0.22 / D4','P0.24 / D5','P1.00 / D6','P0.11 / D7','P1.04 / D8','P1.06 / D9']
right=['BAT+','GND','RST','3.3V','P0.31 / D21','P0.29 / D20','P0.02 / D19','P1.15 / D18','P1.13 / D15','P1.11 / D14','P0.10 / D16','P0.09 / D10']
parts={'TX.PTT':'C21','TX.GND':'C23','TX.CLK':'C25','TX.DAT':'C26','TX.3V3':'G24','MIC.3V':'J6','MIC.GND':'J7','MIC.SEL':'J8','MIC.CLK':'J9','MIC.DAT':'J10','SW.A1':'E13','SW.A2':'F13','SW.B1':'E15','SW.B2':'F15'}
wires=[
 {'net':'PTT','from':'A21','to':'A13','via':[(220,700),(220,492)]},
 {'net':'GND','from':'A23','to':'G7','via':[(192,752),(192,336)]},
 {'net':'GND','from':'H7','to':'H8','via':[]},
 {'net':'GND','from':'F7','to':'J15','via':[(414,336),(414,458),(578,458),(578,544)]},
 {'net':'3V3','from':'J24','to':'F6','via':[(808,778),(808,268),(442,268)]},
 {'net':'CLK','from':'A25','to':'F9','via':[(158,804),(158,388)]},
 {'net':'DAT','from':'A26','to':'F10','via':[(132,830),(132,414)]},
]
# Check the actual breadboard contact groups. The A-E and F-J halves are separate.
parent={}
def find(a):
 parent.setdefault(a,a)
 if parent[a]!=a:parent[a]=find(parent[a])
 return parent[a]
def join(a,b):parent[find(a)]=find(b)
for row in range(1,31):
 for half in ['ABCDE','FGHIJ']:
  for c in half:join(f'{half[0]}{row}',f'{c}{row}')
for w in wires:join(w['from'],w['to'])
# Tactile switch fixed internal pairs: the top pair and bottom pair are internally common; pressing joins the pairs.
join(parts['SW.A1'],parts['SW.A2']);join(parts['SW.B1'],parts['SW.B2'])
expected=[['TX.3V3','MIC.3V'],['TX.GND','MIC.GND','MIC.SEL','SW.B1','SW.B2'],['TX.CLK','MIC.CLK'],['TX.DAT','MIC.DAT'],['TX.PTT','SW.A1','SW.A2']]
roots=[]
for group in expected:
 r={find(parts[k]) for k in group}
 assert len(r)==1,group
 roots.append(next(iter(r)))
assert len(set(roots))==5,'unintended short'
join(parts['SW.A1'],parts['SW.B2'])
assert find(parts['TX.PTT'])==find(parts['TX.GND'])
assert len({find(parts[k]) for k in ['TX.3V3','TX.GND','TX.CLK','TX.DAT']})==4
netlist={'title':'Vaibik USB-powered breadboard prototype','board_reference':'nice!nano v2 front view, USB at top','firmware_target':'promicro_nrf52840/nrf52840/uf2','grid':'30 rows, A-E and F-J form separate five-contact groups per row; power rails unused','parts':parts,'jumpers':[{k:v for k,v in w.items() if k!='via'} for w in wires],'switch':'normally open; E13/F13 internally common and E15/F15 internally common in shown orientation; diagonal E13/F15 wired; press connects PTT to GND','verified':'All five expected nets separate with button released. Press connects only PTT to GND.'}
(ROOT/'wiring-netlist.json').write_text(json.dumps(netlist,indent=2)+'\n')
a=['''<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1240" viewBox="0 0 1800 1240" role="img" aria-labelledby="title desc">
<title id="title">Vaibik — USB-powered breadboard wiring</title>
<desc id="desc">Exact reference wiring for a nice!nano v2-compatible nRF52840 transmitter, Adafruit PDM microphone breakout 3492, and normally open PTT switch. The microphone uses 3.3 volts, common ground, SEL to ground, CLK P0.17 and DAT P0.20. PTT P0.06 switches to ground. A separate receiver connects to the computer by USB and communicates by 2.4 GHz radio. No signal wire links the two boards.</desc>
<defs><style>
text{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#e6edf1}
.title{font-size:33px;font-weight:750;letter-spacing:-1px}.sub{font-size:17px;fill:#aab8c5}.label{font-size:16px}.small{font-size:13px;fill:#acb9c5}.tiny{font-size:10px;fill:#bdc9d3}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:17px}.heading{font-size:21px;font-weight:700}.rowno{font-size:11px;fill:#666d75}.pin{font-size:9px;fill:#d9e0e6}.dark{fill:#273240;font-size:12px;font-weight:700}
</style><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M1 1 L6 4 L1 7" fill="none" stroke="#7ecabb" stroke-width="1.4"/></marker></defs>
<rect width="1800" height="1240" rx="24" fill="#101820"/>
''']
a += [text(66,61,'Vaibik / breadboard build','title'),text(66,94,'USB-powered bench prototype · exact wiring reference · no battery or enclosure','sub')]
a += [text(66,143,'TRANSMITTER','heading'),text(845,143,'RECEIVER / MAC','heading')]
# Breadboard, unused rails, and exact row and column contacts.
a += ['<rect x="110" y="158" width="586" height="792" rx="18" fill="#cfd3d4" stroke="#929da1" stroke-width="2"/>','<rect x="119" y="165" width="568" height="777" rx="13" fill="#ebebdf"/>','<rect x="378" y="170" width="50" height="774" rx="16" fill="#cbd0cb"/>']
for x in (178,204,602,628):
 railcolor='#bd514b' if x in (178,628) else '#4e83ae'
 a.append(line(x-11,177,x-11,938,railcolor,2))
 for g in range(5):
  for i in range(5):a.append(circle(x,180+(g*6+i)*p,3.6,'#535c61'))
for row in range(1,31):
 y=pos(f'A{row}')[1]
 for half in ['ABCDE','FGHIJ']:
  a.append(line(cols[half[0]],y,cols[half[-1]],y,'#cdd1c9',3))
 for c,x in cols.items():a.append(circle(x,y,3.7,'#4b555a'))
 a += [text(237,y+4,row,'rowno','text-anchor="end"'),text(564,y+4,row,'rowno')]
for c,x in cols.items():a.append(text(x,173,c,'dark','text-anchor="middle"'))
a += [text(126,1049,'Rails unused. A–E share a row; F–J share a row. Center channel separates them.','small')]
# Color the connected horizontal breadboard contact strips used by each net.
strip=[('PTT','A21','E21'),('PTT','A13','E13'),('GND','A23','E23'),('GND','F7','J7'),('GND','F8','J8'),('GND','F15','J15'),('3V3','F24','J24'),('3V3','F6','J6'),('CLK','A25','E25'),('CLK','F9','J9'),('DAT','A26','E26'),('DAT','F10','J10')]
for net,h1,h2 in strip:
 x1,y1=pos(h1);x2,y2=pos(h2)
 a.append(line(x1,y1,x2,y2,colors[net],10,'opacity=".27" stroke-linecap="round"'))
# Rotated five-pin PDM module: every header contact has its own row.
a += ['<rect x="534" y="284" width="156" height="155" rx="13" fill="#174e83" stroke="#73a3c9" stroke-width="2"/>',circle(668,306,10,'#d2b35e','#f5d88a',3),circle(668,416,10,'#d2b35e','#f5d88a',3),'<rect x="612" y="334" width="38" height="53" rx="4" fill="#b4bdc6" stroke="#e2e7eb"/>',circle(632,358,4,'#151c24')]
for row,name in zip(range(6,11),['3V','GND','SEL','CLK','DAT']):
 x,y=pos('J'+str(row));a += [circle(x,y,7,'#d5b45d','#f6d791',2),circle(x,y,3,'#18252d'),text(x+13,y+4,name,'pin')]
a += [text(700,325,'PDM #3492','small'),text(700,348,'90° rotation','small'),text(700,371,'5 rows','small')]
# 4-lead momentary switch over ravine, diagonal externally connected.
for h in ['E13','F13','E15','F15']:
 x,y=pos(h);a += [circle(x,y,5,'#c7cbd2','#677681',1),line(x,y,402,y,'#a4adb4',5)]
a += ['<rect x="374" y="480" width="58" height="78" rx="5" fill="#232c35" stroke="#111922" stroke-width="2"/>','<rect x="379" y="486" width="48" height="66" rx="4" fill="#a9b2b8"/>',circle(403,519,19,'#232c35','#111820',2)]
a += ['<rect x="270" y="451" width="44" height="23" rx="3" fill="#ebebdf"/>',text(275,467,'PTT','dark'),'<rect x="270" y="559" width="111" height="23" rx="3" fill="#ebebdf"/>',text(275,575,'NO momentary','dark')]
# Nice!nano v2 standard 12-pin headers, with lower two contacts beyond strip edge.
a += ['<rect x="290" y="658" width="200" height="369" rx="12" fill="#202a31" stroke="#596771" stroke-width="2"/>','<rect x="352" y="634" width="76" height="62" rx="7" fill="#a4acb2" stroke="#d1d6d9" stroke-width="2"/>','<rect x="360" y="640" width="60" height="12" rx="3" fill="#27323a"/>','<rect x="359" y="832" width="65" height="67" rx="3" fill="#11181e" stroke="#48535b"/>']
for idx in range(12):
 y=700+idx*p
 for x,name,anchor,dx in [(312,left[idx],'start',11),(468,right[idx],'end',-11)]:
  net=None
  if x==312:net={0:'PTT',2:'GND',4:'CLK',5:'DAT'}.get(idx)
  if x==468:net={3:'3V3'}.get(idx)
  col=colors[net] if net else '#b49a52'
  a += [circle(x,y,7,col,'#d1b96d',1.5),circle(x,y,3,'#101820'),text(x+dx,y+3,name,'pin',f'text-anchor="{anchor}"')]
a += [text(389,817,'nRF52840','pin','text-anchor="middle"'),text(389,918,'nice!nano v2 pin order','pin','text-anchor="middle"')]
# Antenna with explicit keep-out beyond breadboard strip.
a += ['<path d="M330 998 V972 H352 V1005 H374 V972 H396 V1005 H418 V972 H446" fill="none" stroke="#cdb56a" stroke-width="4"/>','<rect x="299" y="957" width="182" height="64" rx="7" fill="none" stroke="#7ecabb" stroke-width="1.5" stroke-dasharray="5 5"/>',text(505,1004,'ANTENNA OVER EDGE','small'),text(505,1025,'Keep wires / metal away','small')]
# Transmitter USB cable exits from the top connector, not antenna end.
a += ['<path d="M390 636 V609 Q390 601 381 601 H308 Q296 601 296 589 V581" fill="none" stroke="#0b1015" stroke-width="15"/>','<path d="M390 636 V609 Q390 601 381 601 H308 Q296 601 296 589 V581" fill="none" stroke="#758492" stroke-width="3"/>','<rect x="300" y="606" width="83" height="22" rx="3" fill="#ebebdf"/>',text(304,620,'USB POWER','dark')]
# Jumper insulation means crossing paths are NOT electrical junctions.
for w in wires:
 pts=[pos(w['from'])]+w['via']+[pos(w['to'])]
 d='M'+' L'.join(f'{x} {y}' for x,y in pts)
 a.append(f'<path d="{d}" fill="none" stroke="#f5f3e8" stroke-width="11" stroke-linejoin="round" stroke-linecap="round"/>')
 a.append(f'<path d="{d}" fill="none" stroke="{colors[w["net"]]}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>')
 for x,y in [pts[0],pts[-1]]:a += [circle(x,y,6,colors[w['net']],'#e8eceb',1.4),circle(x,y,1.6,'#e6ebea')]
# Receiver and host separated by wireless air gap. No inter-board signal cable.
a += ['<rect x="1297" y="183" width="112" height="216" rx="9" fill="#202a31" stroke="#67747e" stroke-width="2"/>','<rect x="1325" y="171" width="56" height="38" rx="4" fill="#b9c1c6"/>','<rect x="1327" y="270" width="53" height="51" fill="#111820"/>']
for i in range(12):
 for x in [1309,1397]:a.append(circle(x,214+i*15.2,3.8,'#c2ab64'))
a.append('<path d="M1324 381 V368 H1338 V385 H1352 V368 H1366 V385 H1380" fill="none" stroke="#cdb56a" stroke-width="3"/>')
a += ['<rect x="1515" y="192" width="210" height="131" rx="10" fill="#263542" stroke="#a0afbb" stroke-width="2"/>','<rect x="1528" y="205" width="184" height="103" rx="5" fill="#142329"/>','<path d="M1496 335 H1744 L1735 344 H1504 Z" fill="#a0afbb"/>','<path d="M1353 171 V156 Q1353 148 1362 148 H1609 Q1620 148 1620 161 V192" fill="none" stroke="#8d9ba7" stroke-width="6"/>',text(1461,139,'USB DATA + POWER','small','text-anchor="middle"'),text(1621,254,'macOS','heading','text-anchor="middle"'),text(1621,281,'VibeMic companion','small','text-anchor="middle"')]
a += ['<path d="M865 296 H1264" fill="none" stroke="#7ecabb" stroke-width="3" stroke-dasharray="10 9" marker-end="url(#arrow)"/>',text(1065,263,'2.4 GHz RADIO','heading','text-anchor="middle"'),text(1065,326,'No wire between the boards','small','text-anchor="middle"'),text(1353,431,'Second nRF52840 board','small','text-anchor="middle"')]
# Authoritative net and hole map.
a += ['<rect x="840" y="477" width="886" height="397" rx="15" fill="#18242e" stroke="#31424f"/>',text(867,514,'CONNECT THESE SEVEN JUMPERS','heading'),text(867,547,'Signal','small'),text(1040,547,'Connection','small'),text(1464,547,'Jumper holes','small')]
rows=[('3V3','3.3V to microphone 3V','J24  to  F6'),('GND','GND to microphone GND','A23  to  G7'),('GND','Microphone SEL to GND','H7  to  H8'),('CLK','P0.17 / D2 to CLK','A25  to  F9'),('DAT','P0.20 / D3 to DAT','A26  to  F10'),('PTT','P0.06 / D1 to switch','A21  to  A13'),('GND','Switch diagonal to GND','F7  to  J15')]
for i,(net,label,holes) in enumerate(rows):
 y=584+i*39
 a += [line(867,y-6,906,y-6,colors[net],6,'stroke-linecap="round"'),text(924,y,net,'mono'),text(1040,y,label,'label'),text(1514,y,holes,'mono','text-anchor="middle"')]
a += [text(866,909,'NO BUTTON PRESS = PTT HIGH','heading'),text(866,937,'Internal pull-up. Pressing connects P0.06 to GND.','label'),text(866,966,'Use diagonal switch legs; verify the contact pairs with a meter.','small'),text(866,995,'SEL is grounded explicitly for the left PDM channel.','small'),text(866,1024,'Insulated wire crossings do not form electrical junctions.','small')]
# Bottom instructions / limitations are concise, separate from diagram.
a += ['<path d="M66 1075 H1734" stroke="#34444f"/>',text(66,1111,'1  USB at top. Follow P0.xx pin IDs; clone silkscreen can differ.','label'),text(66,1142,'2  Mount PDM pins J6–J10 in five different rows. Leave its acoustic port clear.','label'),text(66,1173,'3  Lower two unused controller pins overhang the breadboard; insulate them.','label'),text(980,1111,'3.3 V ONLY at the microphone. Never use RAW / BAT+ / 5 V.','label'),text(980,1142,'Reference: nice!nano v2 + Adafruit PDM #3492.','small'),text(980,1173,'Reference drawing; physical assembly still needs a bench test.','small')]
a.append('</svg>')
(ROOT/'wiring-breadboard.svg').write_text('\n'.join(a))
print('Verified five isolated nets with PTT released; press joins only PTT and GND.')
print('Saved wiring-breadboard.svg and wiring-netlist.json')
