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