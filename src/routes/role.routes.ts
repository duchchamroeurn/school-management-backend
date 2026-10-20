import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as roleController from '../controllers/role.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const { ROLE } = PERMISSIONS;

export const roleRoutes = Router();
roleRoutes.use(authenticate());

roleRoutes.get('/', requirePermission(ROLE.LIST), roleController.list);
roleRoutes.get('/:id', requirePermission(ROLE.VIEW), roleController.get);
roleRoutes.post('/', requirePermission(ROLE.CREATE), roleController.create);
roleRoutes.patch('/:id', requirePermission(ROLE.UPDATE), roleController.update);
roleRoutes.put('/:id/permissions', requirePermission(ROLE.UPDATE), roleController.setPermissions);
roleRoutes.delete('/:id', requirePermission(ROLE.DELETE), roleController.remove);

// Permission catalogue (read-only: permissions are defined in code)
export const permissionRoutes = Router();
permissionRoutes.use(authenticate());

permissionRoutes.get('/', requirePermission(ROLE.VIEW), roleController.listPermissions);
