import { Router } from 'express';
import * as locationController from '../controllers/location.controller';
import { authenticate } from '../middlewares/authenticate';

// The gazetteer is public reference data: any signed-in user may read it (e.g. to fill in an address)
const router = Router();

router.use(authenticate());

router.get('/provinces', locationController.provinces);
router.get('/provinces/:code/districts', locationController.districts);
router.get('/districts/:code/communes', locationController.communes);
router.get('/communes/:code/villages', locationController.villages);
router.get('/villages', locationController.searchVillages);
router.get('/villages/:code', locationController.village);

export default router;
