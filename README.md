## Getting Started
Install dependenciess
```bash
npm i
```

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Data Availability
The current example data folder covers August 1 2017 from 00:00 to 23:00. To process more yourself you can download era5 data and look at the scripts folder. 

## The Vision/Ideas
For hurricane Irma make the following 3 maps:
- 500 hPa height map
- steering current arrows
- SST

Overlay a simple mapbox map and then implement shaders for the 500hpa height map
- the shaders will make it 3d so we will see hills and valleys popping in/out of the screen
- the steering current will have arrows or maybe particles moving 
- the hurricane will be show by some icon? maybe wind speed overlay or something? dunno
- sst might be helpful as a color overlay

the vision is to see the hurricane move like a ball on a sheet with valleys and hills being pushed by the steering current. it should explain why the hurricane took this path. sst could help show intensity or something?

another thing is to show multiple times for weather on the SAME map. no time slider showing a single time step of weather at a time. so irma was at coords x1, x2, x3 at dates y1, y2, y3. on a single map at coords x1 we show weather at y1, at coords x2 we show weather at y2, etc. on a single map we should see a unified view explaining why the track is that shape
- however this is likely to be confusing as at a single timestep the weather will look correct. 500hpa height will look like it makes sense but displaying weather with multiple timesteps will make it look like we cut up multiple height maps and then placed them next to each other. and also the larger context could be lost like there might have been something important at some coords at time t that were covered up by weather at t+1

to wind particles
- can add u,v to show the 2d direction wind is going
- can add vertical wind to show if it's going up or down
- vorticity to show cyclonic development
- show density of air too currently showing wind particle per some interval but real wind has differing amounts of pressure and need to show that too. not only grid particle or random initialization but particle density similar to real density

ideas:
- color 3d space by temperature
- make clouds as fog with era5
- color ocean by temp?
- simulate waves 
- more verticality in wind
- make wind particles not clustered
- nasa gibs tiles on ground so you can look down while flying around

ways to make wind particles better
- more dense initialization
- with tail and fade out on death
- rk4
- cos stuff since it's on earth
- in encoding dont scale with min/max, scale with defined units
- color particles by altitude?

future ideas:
- waves
- clouds
    - currently have them as 2d layers
    - need to make them actually 3d now
- vertical air particle motion -- although would this conflict with air particles z values being determined by gph currently. 
    - answer is depending on which variable i get. if i look at the rising/sinking nature of air at a certain pressure level that is equivalent to gph since that tells me how air is rising and sinking at a given pressure level. if i look at variables that tell me absolutely rising/sinking nature then it's different and will generally line up with gph in quiet flows but in things like hurricanes will not line up with gph ie. not stay at a single pressure level
- integrate with globegl or turn it into a globe rather than rectangle
    - need to disable stretch in this line
    - // WHEN MOVING TO GLOBE RATHER THAN RECTANGLE, REMOVE COSPHI
    - float du = (dlon_deg / 360.0) * cosphi;
- color particles by temperature. this would help with telling what altitude particles are on
- make shaders not components so moving to next hour animation is better
- increase resolution of mesh, wind, etc
- thunder
- precip
    - to start can make precip drop from the top/low cloud layer
    - then can analyze to figure out what type of precip, where it was likely to fall from
- physics nets to make more realistic motion
- make clouds move with wind
- day/night cycles
- use nasa worldview satellite/other satellite images as sources for data?
    - might be better to pull underlying data if possible rather than satellite
- finer resolution like hrrr
- temperature as 3d mesh
- tweakpane working with things like wind particle resolution -- UV_POINTS_STEP
- modify shaders to get more tweak pane uniforms
- actually implement vertical wind motion according to era5
- do sea surface temp similar to atmospheric temp
- fix up the components such that when you switch the time, it doesnt erase everything on screen and render a new thing. basically properly update uniforms when a mat has already been created.
- create google maps like drag person and place on ground and it automatically sets you at ground height with correct pitch where you drag it
- lod as you zoom in and out
- add 3d stuff on the surface like mapbox 3d tiles
- add speed toggle for controls and perhaps have small map overlay that shows where they are
- prevent altitude from going into the earth
- make sure exampleData and data are consistent