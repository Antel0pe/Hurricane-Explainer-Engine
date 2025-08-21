This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## The Vision
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